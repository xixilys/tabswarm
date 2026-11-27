// gemweb goal: keep pushing a goal forward in small Gemini rounds until a done check passes.
//
// Progress lives in files, not in a chat: <cwd>/.gemweb/goals/<name>/GOAL.md (goal, done criterion,
// done so far, next step, pitfalls, round log) plus state.json (runner bookkeeping). Every round is a
// fresh gemweb task that reads GOAL.md, does one small step and writes GOAL.md back. Whether the goal
// is met is never Gemini's call: the runner runs the done command (exit 0 = done) or, for a text
// criterion, asks a cheap independent model to judge GOAL.md against the actual files.
// The daemon (`gemweb goal daemon`, a LaunchAgent) resumes running goals after a restart.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn, execFileSync } from 'node:child_process';
import { STATE_DIR, expandHome, loadSecrets, LAUNCHD_PREFIX } from './config.js';

const REG = path.join(STATE_DIR, 'goals.json');
const NAME_RE = /^[A-Za-z0-9][\w.-]{0,39}$/;
const OWNER_RE = /NEEDS OWNER DECISION|需要.{0,4}决定/i;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => new Date().toISOString();

// ---------------- files ----------------
function readJson(p, d) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return d; } }
function writeJson(p, v) { const t = `${p}.tmp-${process.pid}`; fs.writeFileSync(t, JSON.stringify(v, null, 2) + '\n'); fs.renameSync(t, p); }
export function registry() { return readJson(REG, {}); }
function setRegistry(r) { writeJson(REG, r); }
export const goalDir = (cwd, name) => path.join(cwd, '.gemweb', 'goals', name);
const goalMd = (dir) => path.join(dir, 'GOAL.md');
export function loadState(dir) { return readJson(path.join(dir, 'state.json'), null); }
// Read-modify-write so the CLI (status changes) and the daemon (round bookkeeping) don't clobber each other.
export function patchState(dir, patch) { const s = { ...(loadState(dir) || {}), ...patch, updated: now() }; writeJson(path.join(dir, 'state.json'), s); return s; }

function findGoal(name) {
  const info = registry()[name];
  if (!info) return null;
  const dir = goalDir(info.cwd, name);
  return { name, cwd: info.cwd, dir, st: loadState(dir) };
}

export function goalsSummary() {
  const out = [];
  for (const [name, info] of Object.entries(registry())) {
    const st = loadState(goalDir(info.cwd, name));
    if (!st) continue;
    const last = (st.rounds || []).slice(-1)[0];
    out.push({
      id: `goal:${name}`, name, cwd: info.cwd, status: st.status, stop_reason: st.stop_reason || null, goal: (st.goal || '').slice(0, 500),
      done: st.done, round: st.round || 0, max_rounds: st.limits?.max_rounds, started: st.started, updated: st.updated, ended: st.ended || null,
      no_progress: st.no_progress || 0, errors: st.errors || 0, current: st.current || null, last_check: st.last_check || null,
      last_summary: last?.summary || '', goal_md: goalMd(goalDir(info.cwd, name)), backoff_until: st.backoff_until || null,
    });
  }
  return out.sort((a, b) => String(b.updated).localeCompare(String(a.updated)));
}

function goalTemplate(name, goal, done) {
  const doneTxt = done.type === 'cmd' ? `Command, run in the goal folder by the runner after every round: \`${done.value}\` (exit code 0 = done).` : `Text criterion, judged by an independent model against this file and the actual files:\n${done.value}`;
  return `# Goal: ${name}

## Goal (目标)
${goal}

## Done when (验收)
${doneTxt}

## Done so far (已完成)
- Nothing yet.

## Next step (下一步)
- Look at the folder and plan the first small step.

## Pitfalls (踩过的坑)
- None yet.

## Round log (每轮摘要 — written by the runner, do not edit)
`;
}

function rewriteRoundLog(dir, st) {
  const p = goalMd(dir);
  let md = ''; try { md = fs.readFileSync(p, 'utf8'); } catch { md = goalTemplate(st.name, st.goal, st.done); }
  const h = md.search(/^## Round log.*$/m);
  const head = h >= 0 ? md.slice(0, h) : md.replace(/\s*$/, '\n\n');
  const lines = (st.rounds || []).map((r) => r.outcome === 'interrupted'
    ? `- R${r.n} ${r.ended?.slice(0, 16).replace('T', ' ')} · interrupted (${r.note || 'restart'}), redone`
    : `- R${r.n} ${r.ended?.slice(0, 16).replace('T', ' ')} · ${r.task_id || '-'} · ${r.outcome} · ${r.progress ? 'progress' : 'no progress'} · check ${r.check}${r.check_summary ? ` (${r.check_summary.replace(/\s+/g, ' ').slice(0, 120)})` : ''}${r.summary ? ` · ${r.summary.replace(/\s+/g, ' ').slice(0, 200)}` : ''}`);
  fs.writeFileSync(p, `${head}## Round log (每轮摘要 — written by the runner, do not edit)\n${lines.join('\n')}${lines.length ? '\n' : ''}`);
}

// ---------------- events / notify ----------------
let adminToken = null;
async function emit(cfg, name, type, data = {}) {
  adminToken ||= loadSecrets().admin_token;
  try {
    await fetch(`http://${cfg.admin_host}:${cfg.admin_port}/api/goals/event`, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({ name, type, ...data }), signal: AbortSignal.timeout(5000),
    });
  } catch { /* server down: the round log in GOAL.md / state.json still has it */ }
}

// Owner-facing QQ message (only when the owner has to act or the goal is done).
function notify(cfg, text, st) {
  if (st?.quiet) return;
  const [cmd, ...args] = (process.env.GEMWEB_GOAL_NOTIFY ? [process.env.GEMWEB_GOAL_NOTIFY] : cfg.gemweb.goal.notify_command || []).map(expandHome); // env override for tests
  if (!cmd) return;
  try { const ch = spawn(cmd, [...args, text], { stdio: 'ignore', detached: true }); ch.on('error', () => {}); ch.unref(); } catch { /* ignore */ }
}

// Problems the owner does not need to handle go to an Orca bot (goal.report_bot), with the technical details.
function tellBot(cfg, subject, body, st) {
  const bot = cfg.gemweb.goal.report_bot;
  if (st?.quiet || !bot) return;
  const orca = ['/Applications/Orca.app/Contents/Resources/bin/orca', '/opt/homebrew/bin/orca', '/usr/local/bin/orca'].find((p) => fs.existsSync(p));
  if (!orca) return;
  try { const ch = spawn(orca, ['orchestration', 'send', '--to', `bot:${bot}`, '--type', 'status', '--subject', subject.slice(0, 120), '--body', body.slice(0, 3000)], { stdio: 'ignore', detached: true }); ch.on('error', () => {}); ch.unref(); } catch { /* ignore */ }
}

// ---------------- done check ----------------
function fingerprint(cwd) {
  // Cheap "did anything change" signal for files Gemini wrote through run_command.
  const skip = new Set(['.git', '.gemweb', 'node_modules', '__pycache__', '.pytest_cache', '.venv', 'venv', '.mypy_cache', '.ruff_cache']);
  const parts = []; let n = 0;
  const walk = (d) => {
    let ents = []; try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents.sort((a, b) => a.name.localeCompare(b.name))) {
      if (n > 5000) return;
      if (skip.has(e.name)) continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) { try { const s = fs.statSync(p); parts.push(`${p}:${s.size}:${Math.floor(s.mtimeMs)}`); n++; } catch { /* */ } }
    }
  };
  walk(cwd);
  return parts.join('\n');
}

function recentFiles(cwd, limit = 8) {
  const files = [];
  for (const line of fingerprint(cwd).split('\n')) {
    const m = /^(.*):(\d+):(\d+)$/.exec(line);
    if (m) files.push({ p: m[1], size: Number(m[2]), mt: Number(m[3]) });
  }
  return files;
}

function runCheckCommand(cmd, cwd, cfg) {
  return new Promise((resolve) => {
    const ch = spawn('/bin/bash', ['-c', cmd], { cwd, env: { PATH: cfg.command_path, HOME: os.homedir(), LANG: 'en_US.UTF-8', TERM: 'dumb' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    const add = (d) => { out += d; if (out.length > 200000) out = out.slice(-100000); };
    ch.stdout.on('data', add); ch.stderr.on('data', add);
    const t = setTimeout(() => ch.kill('SIGKILL'), (cfg.gemweb.goal.check_timeout_sec || 600) * 1000);
    ch.on('error', (e) => { clearTimeout(t); resolve({ pass: false, code: -1, summary: `could not run: ${e.message}`, output: '' }); });
    ch.on('close', (code, sig) => {
      clearTimeout(t);
      const lastLine = out.trim().split('\n').filter((l) => l.trim()).slice(-1)[0] || '';
      resolve({ pass: code === 0, code, summary: `exit ${code ?? sig}${lastLine ? `: ${lastLine.slice(0, 160)}` : ''}`, output: out.slice(-3000) });
    });
  });
}

async function runCheckText(criterion, cwd, dir, cfg) {
  const { askModel } = await import('./driver.js');
  let md = ''; try { md = fs.readFileSync(goalMd(dir), 'utf8'); } catch { /* */ }
  const files = recentFiles(cwd);
  const tree = files.slice(0, 300).map((f) => `${path.relative(cwd, f.p)} (${f.size} B)`).join('\n');
  let budget = 80000; const bodies = [];
  for (const f of [...files].sort((a, b) => b.mt - a.mt).slice(0, 8)) {
    if (f.size > 30000 || budget <= 0) continue;
    let txt; try { txt = fs.readFileSync(f.p, 'utf8'); } catch { continue; }
    if (txt.includes('\u0000')) continue;
    budget -= txt.length; bodies.push(`----- ${path.relative(cwd, f.p)} -----\n${txt}`);
  }
  const prompt = `You are an independent reviewer. Decide strictly whether a goal is met, based ONLY on the actual files below, not on claims in the goal file. Do not modify anything and do not use tools.

DONE CRITERION:
${criterion}

GOAL FILE (written by the worker; its "Done so far" section may be optimistic):
${md.slice(0, 20000)}

FILES IN ${cwd} (most recent contents follow):
${tree}

${bodies.join('\n\n')}

Reply with exactly one first line "VERDICT: PASS" or "VERDICT: FAIL", then one line with the main reason (<= 200 chars).`;
  const r = await askModel({ prompt, cfg, models: cfg.gemweb.goal.judge_models?.length ? cfg.gemweb.goal.judge_models : cfg.gemweb.operator_models, timeoutSec: 300 });
  if (!r.ok) return { pass: false, code: null, summary: `judge unavailable (${r.tried.join('; ').slice(0, 200)})`, output: '' };
  const pass = /VERDICT:\s*PASS/i.test(r.text) && !/VERDICT:\s*FAIL/i.test(r.text);
  const reason = r.text.split('\n').map((l) => l.trim()).filter((l) => l && !/^VERDICT/i.test(l))[0] || '';
  return { pass, code: null, summary: `${pass ? 'PASS' : 'FAIL'} by ${r.model}${reason ? `: ${reason.slice(0, 200)}` : ''}`, output: r.text.slice(0, 2000) };
}

function runCheck(st, dir, cfg) { return st.done.type === 'cmd' ? runCheckCommand(st.done.value, st.cwd, cfg) : runCheckText(st.done.value, st.cwd, dir, cfg); }

// ---------------- one round ----------------
function roundPrompt(st, dir, n) {
  const lc = st.last_check;
  const check = lc ? `${lc.pass ? 'PASSED' : 'NOT MET'} — ${lc.summary}${lc.output && !lc.pass ? `\nOutput tail:\n${lc.output.slice(-1500)}` : ''}` : 'not run yet';
  return `Long-running goal "${st.name}", round ${n}. Each round is a fresh chat that does ONE small step; the goal file is the only memory between rounds.
Goal folder (work only inside it): ${st.cwd}
Goal file: ${goalMd(dir)}
The goal (also in the goal file):
${st.goal.slice(0, 1500)}

1. Read the goal file first.
2. Do ONE small, concrete step toward the goal (normally what "Next step" says). Keep it small enough to finish in this round, and verify it (e.g. run the tests).
3. Edit the goal file: update "Done so far", rewrite "Next step" as the single next small step, and add anything that went wrong to "Pitfalls". Leave the "Round log" section alone (the runner writes it).
4. If you cannot continue without the owner deciding something, write a line "NEEDS OWNER DECISION: <in short plain Chinese, what the owner must decide and the options>" under "Next step", put the same line in your report, and stop.
5. Finish with report(status="final") summarising this round's step in one or two sentences.

The runner decides when the goal is met by checking: ${st.done.type === 'cmd' ? `\`${st.done.value}\` exits 0` : 'an independent review of the files against the done criterion'}.
Last check result: ${check}`;
}

// Same browser path as a normal `gemweb` dispatch (the dedicated Chrome by default, never --browser);
// --driver only for offline tests.
export function roundArgs({ gemwebPath, st, n, pf, timeout }) {
  return [gemwebPath, '-f', pf, '--from', `goal:${st.name}`, '--title', `goal ${st.name} · R${n}`, '--timeout', String(timeout), ...(st.driver ? ['--driver', st.driver] : [])];
}

function spawnRound({ gemwebPath, st, dir, n, cfg, running }) {
  return new Promise((resolve) => {
    const rd = path.join(dir, 'rounds'); fs.mkdirSync(rd, { recursive: true });
    const pf = path.join(rd, `R${n}-prompt.md`); fs.writeFileSync(pf, roundPrompt(st, dir, n));
    const logf = fs.openSync(path.join(rd, `R${n}.log`), 'a');
    const timeout = cfg.gemweb.goal.round_timeout_sec || 1800;
    const ch = spawn(process.execPath, roundArgs({ gemwebPath, st, n, pf, timeout }), { cwd: st.cwd, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, GEMWEB_FROM: `goal:${st.name}` } });
    running.child = ch;
    let out = '', err = '', taskId = null;
    ch.stdout.on('data', (d) => { out += d; fs.writeSync(logf, d); });
    ch.stderr.on('data', (d) => {
      err += d; fs.writeSync(logf, d);
      const m = /TASK_ID=(\S+)/.exec(err);
      if (m && !taskId) { taskId = m[1]; running.taskId = taskId; patchState(dir, { current: { ...(loadState(dir)?.current || {}), task_id: taskId } }); }
    });
    const guard = setTimeout(() => ch.kill('SIGTERM'), (timeout + 600) * 1000);
    ch.on('close', (code, signal) => { clearTimeout(guard); fs.closeSync(logf); running.child = null; resolve({ code, signal, out, err, taskId }); });
  });
}

async function adminGet(cfg, p) {
  adminToken ||= loadSecrets().admin_token;
  for (let i = 0; i < 20; i++) {
    try {
      const r = await fetch(`http://${cfg.admin_host}:${cfg.admin_port}/api${p}`, { headers: { authorization: `Bearer ${adminToken}` }, signal: AbortSignal.timeout(10000) });
      if (r.ok) return r.json();
      if (r.status === 404) return null;
    } catch { /* server restarting */ }
    await sleep(3000);
  }
  return null;
}

// Owner-facing texts: short plain Chinese, say what to do and where; no English errors, no commands.
export const QQ = {
  done: (st) => `目标「${st.name}」完成了：第 ${st.round} 轮后自动验收通过。结果在 ${st.cwd}。`,
  needs_owner: (st, line) => `目标「${st.name}」需要你拍板：${line.replace(/^.*?(NEEDS OWNER DECISION|需要.{0,4}决定)\s*[:：]?\s*/i, '').slice(0, 160)}。详情写在目标文件的“下一步”里，你定了以后告诉助手继续。`,
  login: (st) => `目标「${st.name}」暂停了：这台 Mac 上专门跑任务的那个 Chrome（不是你平时用的）里 Gemini 没登录或登录过期了。请让助手打开登录窗口，你在窗口里登录 Google，登好后告诉助手继续这个目标。`,
};
const BOT = {
  stalled: (st) => [`goal ${st.name} stalled`, `gemweb goal "${st.name}" stopped: ${st.no_progress} rounds in a row changed no files.\nGOAL.md: ${goalMd(goalDir(st.cwd, st.name))}\nLast check: ${st.last_check?.summary || '-'}\nResume after fixing: gemweb goal resume ${st.name}`],
  error: (st, why) => [`goal ${st.name} keeps failing`, `gemweb goal "${st.name}" stopped after ${st.errors} failed rounds in a row.\nLast error: ${why}\nRound logs: ${goalDir(st.cwd, st.name)}/rounds\nResume: gemweb goal resume ${st.name}`],
  limit: (st, why) => [`goal ${st.name} hit its limit`, `gemweb goal "${st.name}" reached its limit (${why}) without passing the done check.\nGOAL.md: ${goalMd(goalDir(st.cwd, st.name))}\nRaise and resume: gemweb goal resume ${st.name} --max-rounds N --max-hours H`],
  webLimit: (st, why) => [`goal ${st.name} paused: web limit`, `gemweb goal "${st.name}" paused: ${why}\nNo retries until it clears. Check: gemweb limit · Resume: gemweb goal resume ${st.name}`],
  browser: (st, why) => [`goal ${st.name} paused: browser`, `gemweb goal "${st.name}" paused because the browser path needs attention (not the owner): ${why}\nResume: gemweb goal resume ${st.name}`],
};

// qq: owner-facing text (or null); bot: [subject, body] for the report bot (or null).
async function finish(cfg, dir, status, reason, { qq = null, bot = null } = {}) {
  const st = patchState(dir, { status, stop_reason: reason, ended: now(), current: null });
  await emit(cfg, st.name, 'goal.stopped', { status, reason, text: `${status}: ${reason}` });
  if (st.quiet) return st;
  if (qq) { notify(cfg, qq, st); await emit(cfg, st.name, 'goal.notified', { text: `QQ → owner: ${qq}` }); }
  if (bot) { tellBot(cfg, bot[0], bot[1], st); await emit(cfg, st.name, 'goal.notified', { text: `→ ${cfg.gemweb.goal.report_bot}: ${bot[0]}` }); }
  return st;
}

function limitHit(st) {
  const L = st.limits || {};
  if ((st.round || 0) >= L.max_rounds) return `${st.round} 轮`;
  if (Date.now() - Date.parse(st.started) > L.max_hours * 3600e3) return `${L.max_hours} 小时`;
  return null;
}

// Runs one goal until it stops (or the daemon is shutting down).
async function runGoal(name, ctx) {
  const { cfg, gemwebPath, running } = ctx;
  const info = registry()[name]; if (!info) return;
  const dir = goalDir(info.cwd, name);
  let st = loadState(dir);
  let finished = null; // a round whose Gemini task had already reported when the runner restarted
  if (st.current?.task_id) {
    const t = await adminGet(cfg, `/tasks/${st.current.task_id}`);
    if (t?.final) finished = { n: st.current.round, res: { taskId: t.id, code: 0, signal: null, out: '', err: '' } };
  }
  if (st.current && !finished) { // the daemon (or machine) restarted mid-round: redo that round from GOAL.md
    const { round: n, task_id: tid, started } = st.current;
    st = patchState(dir, { current: null, rounds: [...(st.rounds || []), { n, task_id: tid, started, ended: now(), outcome: 'interrupted', note: 'runner restarted' }] });
    rewriteRoundLog(dir, st);
    await emit(cfg, name, 'goal.round_interrupted', { round: n, round_task: tid, text: `R${n} was interrupted by a restart; redoing it from GOAL.md` });
  }
  if (!st.last_check) {
    const c = await runCheck(st, dir, cfg);
    st = patchState(dir, { last_check: { ...c, at: now(), round: 0 } });
    await emit(cfg, name, 'goal.check', { round: 0, pass: c.pass, text: `initial check: ${c.summary}` });
    if (c.pass) return finish(cfg, dir, 'done', 'already met before round 1', { qq: QQ.done(st) });
  }
  while (!ctx.stopping) {
    st = loadState(dir);
    if (!st || st.status !== 'running') return;
    const lim = limitHit(st);
    if (lim) return finish(cfg, dir, 'limit', `limit reached (${lim})`, { bot: BOT.limit(st, lim) });
    if (st.backoff_until && Date.parse(st.backoff_until) > Date.now()) {
      await sleep(Math.min(5000, Date.parse(st.backoff_until) - Date.now()));
      continue;
    }
    let n, before, res;
    if (finished) { // pick up the round that completed just before the restart instead of redoing it
      ({ n, res } = finished); before = null; finished = null;
      await emit(cfg, name, 'goal.round_resumed', { round: n, round_task: res.taskId, text: `R${n} had already reported before the restart; checking its result` });
    } else {
      n = (st.round || 0) + 1;
      before = fingerprint(st.cwd);
      st = patchState(dir, { current: { round: n, started: now(), task_id: null, runner_pid: process.pid } });
      await emit(cfg, name, 'goal.round_start', { round: n, text: `R${n} started` });
      res = await spawnRound({ gemwebPath, st, dir, n, cfg, running });
    }
    if (ctx.stopping) return; // shutting down: state.current stays set, the round is redone or picked up after restart
    st = loadState(dir);
    if (st.status === 'stopped') { // `gemweb goal stop` killed the round
      st = patchState(dir, { current: null, rounds: [...(st.rounds || []), { n, task_id: res.taskId, ended: now(), outcome: 'interrupted', note: 'stopped by owner' }] });
      rewriteRoundLog(dir, st);
      return;
    }
    const t = res.taskId ? await adminGet(cfg, `/tasks/${res.taskId}`) : null;
    const tracked = (t?.files_changed || []).filter((f) => !f.includes(`${path.sep}.gemweb${path.sep}`));
    const progress = tracked.length > 0 || (before !== null && fingerprint(st.cwd) !== before);
    const final = t?.final || null;
    const reportText = final ? `${final.summary || ''}\n${final.content || ''}` : '';
    // Only a sign-in problem needs the owner; a missing connector goes to the bot.
    const browserBlock = !final && (/BLOCKED: auth\|/.test(res.out) ? 'login' : /BLOCKED: connector-missing\|/.test(res.out) ? 'connector' : null);
    // Gemini's usage limit or gemweb's daily cap: stop pushing and report, no retry loop.
    const webLimit = !final && (/BLOCKED: (rate-limit|daily-cap)\|.*/.exec(res.out)?.[0] || null);
    const outcome = final ? (final.status === 'final' ? 'reported' : 'blocked') : webLimit ? 'web-limit' : browserBlock ? 'browser-blocked' : 'error';
    const errWhy = outcome === 'error' ? (t?.error || res.err.trim().split('\n').slice(-1)[0] || `exit ${res.code}`) : '';
    // The runner, not Gemini, decides whether the goal is met.
    const c = await runCheck(st, dir, cfg);
    const roundRec = { n, task_id: res.taskId, started: st.current?.started, ended: now(), outcome, progress, files: tracked.length, check: c.pass ? 'pass' : 'fail', check_summary: c.summary, summary: (final?.summary || errWhy || '').slice(0, 300) };
    const errors = outcome === 'error' ? (st.errors || 0) + 1 : 0;
    const noProgress = ['error', 'browser-blocked', 'web-limit'].includes(outcome) ? (st.no_progress || 0) : progress ? 0 : (st.no_progress || 0) + 1;
    st = patchState(dir, {
      current: null, round: outcome === 'reported' || outcome === 'blocked' || progress ? n : st.round || 0, // failed attempts don't use up a round
      rounds: [...(st.rounds || []), roundRec].slice(-200),
      last_check: { ...c, at: now(), round: n }, errors, no_progress: noProgress,
      backoff_until: outcome === 'error' ? new Date(Date.now() + Math.min(30 * 60e3, 60e3 * 2 ** (errors - 1))).toISOString() : null,
    });
    rewriteRoundLog(dir, st);
    await emit(cfg, name, 'goal.round_end', { round: n, round_task: res.taskId, outcome, progress, pass: c.pass, text: `R${n} ${outcome} · ${progress ? 'progress' : 'no progress'} · check ${c.pass ? 'PASS' : 'fail'} (${c.summary.slice(0, 140)})${roundRec.summary ? ' · ' + roundRec.summary.slice(0, 160) : ''}` });
    if (c.pass) return finish(cfg, dir, 'done', `done check passed after round ${n}`, { qq: QQ.done(st) });
    const ownerLine = OWNER_RE.test(reportText) ? (reportText.split('\n').find((l) => OWNER_RE.test(l)) || reportText).trim() : null;
    if (ownerLine) return finish(cfg, dir, 'needs_owner', ownerLine.slice(0, 300), { qq: QQ.needs_owner(st, ownerLine) });
    if (webLimit) return finish(cfg, dir, 'paused', webLimit.slice(0, 300), { bot: BOT.webLimit(st, webLimit.slice(9, 400)) });
    if (browserBlock === 'login') return finish(cfg, dir, 'paused', `the dedicated Chrome is not signed in to Gemini (gwmcp login gemini): ${res.out.trim().slice(0, 200)}`, { qq: QQ.login(st) });
    if (browserBlock) return finish(cfg, dir, 'paused', `browser: ${res.out.trim().slice(0, 200)}`, { bot: BOT.browser(st, res.out.trim()) });
    if (noProgress >= st.limits.no_progress_rounds) return finish(cfg, dir, 'stalled', `${noProgress} rounds in a row without progress`, { bot: BOT.stalled(st) });
    if (errors >= (cfg.gemweb.goal.max_errors || 10)) return finish(cfg, dir, 'error', `${errors} failed rounds in a row: ${errWhy}`.slice(0, 300), { bot: BOT.error(st, errWhy) });
  }
}

// ---------------- daemon ----------------
export async function daemon({ cfg, gemwebPath }) {
  const ctx = { cfg, gemwebPath, stopping: false, goals: new Map() };
  const log = (...a) => console.log(now(), ...a);
  log(`goal daemon started pid ${process.pid}`);
  const shutdown = async (sig) => {
    if (ctx.stopping) return; ctx.stopping = true;
    log(`${sig}: stopping ${ctx.goals.size} running goal(s); their current round is redone after restart`);
    for (const g of ctx.goals.values()) g.child?.kill('SIGTERM'); // gemweb closes its own tab and cancels the task
    const until = Date.now() + 15000;
    while ([...ctx.goals.values()].some((g) => g.child) && Date.now() < until) await sleep(300);
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM')); process.on('SIGINT', () => shutdown('SIGINT'));
  for (;;) {
    for (const [name, info] of Object.entries(registry())) {
      const dir = goalDir(info.cwd, name);
      const st = loadState(dir);
      const g = ctx.goals.get(name);
      if (st?.status === 'running' && !g && !ctx.stopping) {
        const running = { child: null, taskId: null };
        ctx.goals.set(name, running);
        log(`goal ${name}: ${st.current ? 'resuming after restart' : 'running'} (round ${st.round || 0})`);
        runGoal(name, { ...ctx, running, get stopping() { return ctx.stopping; } })
          .catch((e) => { log(`goal ${name}: runner error ${e.stack || e}`); try { patchState(dir, { errors: (loadState(dir)?.errors || 0) + 1, backoff_until: new Date(Date.now() + 60e3).toISOString() }); } catch { /* */ } })
          .finally(() => { ctx.goals.delete(name); log(`goal ${name}: loop ended (${loadState(dir)?.status})`); });
      } else if (g && st?.status === 'stopped' && g.child) {
        log(`goal ${name}: stop requested, ending round`); g.child.kill('SIGTERM');
      }
    }
    await sleep(3000);
  }
}

// ---------------- CLI ----------------
const HELP = `gemweb goal — keep pushing a goal forward in small Gemini rounds until it is met.

  gemweb goal start --name X --cwd DIR --goal "目标" --done "pytest -q"   (or --goal-file F, --done-text "文字标准")
        [--max-rounds 50] [--max-hours 24] [--no-progress 3] [--quiet: no QQ/bot messages] [--driver mock: offline test]
  gemweb goal list                  all goals with status and round
  gemweb goal status X              details, next step, last rounds
  gemweb goal log X                 every round (task id, progress, check result, summary)
  gemweb goal pause X | resume X | stop X | forget X   (forget: drop a stopped goal from the list, keep its files)
        resume also takes --max-rounds / --max-hours / --no-progress to raise limits
  gemweb goal daemon                the runner (started by launchd: gwmcp install)

--done: a shell command run in DIR after every round (exit 0 = done). Text that is not a runnable
command (or --done-text) is judged by a cheap independent model (goal.judge_models, else gemweb.operator_models).
Progress lives in DIR/.gemweb/goals/X/GOAL.md; each round is a new Gemini task that reads it,
does one small step and writes it back. Stops when done, after 3 rounds without progress, when
Gemini writes "NEEDS OWNER DECISION:", or at the round/time limit. The owner is notified
(goal.notify_command, plain Chinese) only when the goal is done or they must act (a decision, the
Gemini sign-in expired); other problems go to goal.report_bot (an Orca bot) when set.`;

function parseFlags(argv) {
  const i0 = argv.indexOf('goal');
  const a = argv.slice(i0 + 1); const f = {}; const pos = [];
  for (let i = 0; i < a.length; i++) {
    const m = /^--([\w-]+)$/.exec(a[i]);
    if (m && i + 1 < a.length && !a[i + 1].startsWith('--')) f[m[1]] = a[++i];
    else if (m) f[m[1]] = true;
    else pos.push(a[i]);
  }
  return { f, pos };
}

function looksLikeCommand(s, cwd, cfg) {
  if (/[　-鿿]/.test(s) || s.length > 300) return false;
  const first = s.trim().split(/\s+/)[0];
  if (!first) return false;
  if (/^(\.{0,2}\/)/.test(first)) return fs.existsSync(path.resolve(cwd, first));
  if (['cd', 'test', '[', 'bash', 'sh', 'make', 'env'].includes(first)) return true;
  try { execFileSync('/bin/bash', ['-c', `command -v ${JSON.stringify(first)}`], { env: { PATH: cfg.command_path }, stdio: 'ignore' }); return true; } catch { return false; }
}

function daemonLoaded() {
  try { execFileSync('/bin/launchctl', ['print', `gui/${process.getuid()}/${LAUNCHD_PREFIX}-goals`], { stdio: 'ignore' }); return true; } catch { return false; }
}

function fmtGoal(g) {
  const st = g.st; const L = st.limits || {};
  return `${g.name.padEnd(18)} ${String(st.status).padEnd(12)} R${st.round || 0}/${L.max_rounds}  check ${st.last_check ? (st.last_check.pass ? 'PASS' : 'fail') : '-'}  ${st.cwd}`;
}

export async function goalCli(_pos, { argv, cfg, gemwebPath }) {
  const { f, pos } = parseFlags(argv);
  const sub = pos[0] || 'help';
  const G = cfg.gemweb.goal;
  const nameArg = f.name || pos[1];
  if (sub === 'help' || f.help || f.h) { console.log(HELP); return 0; }
  if (sub === 'daemon') { await daemon({ cfg, gemwebPath }); return 0; }
  if (sub === 'list') {
    const reg = registry();
    if (!Object.keys(reg).length) { console.log('no goals'); return 0; }
    for (const name of Object.keys(reg)) { const g = findGoal(name); if (g?.st) console.log(fmtGoal(g)); }
    return 0;
  }
  if (sub === 'start') {
    const name = f.name; const goal = f['goal-file'] ? fs.readFileSync(f['goal-file'], 'utf8').trim() : f.goal;
    if (!name || !NAME_RE.test(name)) { console.error('gemweb goal start: --name must be letters/digits/._- (<=40)'); return 2; }
    if (!f.cwd || !goal || !(f.done || f['done-text'] || f['done-cmd'])) { console.error('usage: gemweb goal start --name X --cwd DIR --goal "目标" --done "命令或文字标准"'); return 2; }
    const cwd = path.resolve(expandHome(f.cwd));
    if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) { console.error(`gemweb goal start: no such folder ${cwd}`); return 2; }
    const roots = cfg.roots.map((r) => r.path);
    if (!roots.some((r) => cwd === r || cwd.startsWith(r + path.sep))) { console.error(`gemweb goal start: ${cwd} is outside the MCP roots, Gemini could not touch it (roots: ${roots.join(', ')})`); return 2; }
    const reg = registry();
    if (reg[name]) { const old = findGoal(name); if (old?.st && ['running', 'paused'].includes(old.st.status)) { console.error(`gemweb goal start: goal ${name} already exists (${old.st.status}); stop it first or pick another name`); return 2; } }
    let done;
    if (f['done-cmd']) done = { type: 'cmd', value: f['done-cmd'] };
    else if (f['done-text']) done = { type: 'text', value: f['done-text'] };
    else done = looksLikeCommand(f.done, cwd, cfg) ? { type: 'cmd', value: f.done } : { type: 'text', value: f.done };
    const dir = goalDir(cwd, name); fs.mkdirSync(path.join(dir, 'rounds'), { recursive: true });
    fs.writeFileSync(goalMd(dir), goalTemplate(name, goal, done));
    const limits = { max_rounds: Number(f['max-rounds'] || G.max_rounds), max_hours: Number(f['max-hours'] || G.max_hours), no_progress_rounds: Number(f['no-progress'] || G.no_progress_rounds) };
    writeJson(path.join(dir, 'state.json'), { name, cwd, goal, done, ...(f.driver ? { driver: String(f.driver) } : {}), ...(f.quiet ? { quiet: true } : {}), status: 'running', created: now(), started: now(), updated: now(), round: 0, rounds: [], no_progress: 0, errors: 0, limits, last_check: null, current: null });
    reg[name] = { cwd, created: now() }; setRegistry(reg);
    await emit(cfg, name, 'goal.started', { text: `started in ${cwd} · done = ${done.type === 'cmd' ? '`' + done.value + '` exits 0' : 'text, judged by an independent model'} · limits ${limits.max_rounds} rounds / ${limits.max_hours} h`, goal: goal.slice(0, 500) });
    console.log(`goal ${name} started\n  folder  ${cwd}\n  file    ${goalMd(dir)}\n  done    ${done.type === 'cmd' ? `command \`${done.value}\` (exit 0)` : `text, judged by ${(G.judge_models?.length ? G.judge_models : cfg.gemweb.operator_models).join(' → ')}`}\n  limits  ${limits.max_rounds} rounds, ${limits.max_hours} h, stop after ${limits.no_progress_rounds} rounds without progress`);
    if (!daemonLoaded()) console.log('  note    the goal runner is not running — start it with: gwmcp install (or gwmcp start goals)');
    return 0;
  }
  const g = nameArg ? findGoal(nameArg) : null;
  if (!g?.st) { console.error(nameArg ? `gemweb goal: no goal named ${nameArg} (gemweb goal list)` : HELP); return 2; }
  if (sub === 'status') {
    const st = g.st; const L = st.limits;
    let next = ''; try { next = (/## Next step[^\n]*\n([\s\S]*?)(\n## |$)/.exec(fs.readFileSync(goalMd(g.dir), 'utf8')) || [])[1]?.trim() || ''; } catch { /* */ }
    console.log(`goal     ${st.name} — ${st.status}${st.stop_reason ? ` (${st.stop_reason})` : ''}
folder   ${st.cwd}
file     ${goalMd(g.dir)}
goal     ${st.goal.split('\n')[0].slice(0, 200)}
done     ${st.done.type === 'cmd' ? `\`${st.done.value}\` exits 0` : st.done.value.slice(0, 200)}
rounds   ${st.round}/${L.max_rounds} · ${st.no_progress}/${L.no_progress_rounds} without progress · ${st.errors} errors in a row · started ${st.started}${st.current ? `\nnow      R${st.current.round} running${st.current.task_id ? ` (task ${st.current.task_id})` : ''}` : ''}${st.backoff_until && Date.parse(st.backoff_until) > Date.now() ? `\nbackoff  until ${st.backoff_until}` : ''}
check    ${st.last_check ? `${st.last_check.pass ? 'PASS' : 'fail'} — ${st.last_check.summary}` : 'not run yet'}
next     ${next.replace(/\n/g, '\n         ')}`);
    for (const r of (st.rounds || []).slice(-3)) console.log(`  R${r.n} ${r.outcome} ${r.progress ? 'progress' : ''} check ${r.check || '-'} ${r.task_id || ''} ${(r.summary || r.note || '').slice(0, 120)}`);
    return 0;
  }
  if (sub === 'log') {
    for (const r of g.st.rounds || []) console.log(`R${r.n}\t${(r.ended || '').slice(0, 19)}\t${r.task_id || '-'}\t${r.outcome}\t${r.progress ? 'progress' : r.outcome === 'interrupted' ? '' : 'no-progress'}\tcheck ${r.check || '-'}\t${(r.check_summary || '').slice(0, 80)}\t${(r.summary || r.note || '').slice(0, 160)}`);
    console.log(`\nGOAL.md: ${goalMd(g.dir)}\nround prompts/logs: ${path.join(g.dir, 'rounds')}`);
    return 0;
  }
  if (sub === 'pause' || sub === 'stop') {
    if (!['running', 'paused'].includes(g.st.status) && sub === 'pause') { console.error(`goal ${g.name} is ${g.st.status}`); return 2; }
    patchState(g.dir, { status: sub === 'pause' ? 'paused' : 'stopped', stop_reason: `${sub} by owner`, ...(sub === 'stop' ? { ended: now() } : {}) });
    await emit(cfg, g.name, sub === 'pause' ? 'goal.paused' : 'goal.stopped', { status: sub === 'pause' ? 'paused' : 'stopped', text: `${sub} by owner${sub === 'pause' ? ' (the current round finishes first)' : ' (the current round is cancelled)'}` });
    console.log(`goal ${g.name}: ${sub === 'pause' ? 'paused (the current round finishes first)' : 'stopped'}`);
    return 0;
  }
  if (sub === 'forget') {
    if (g.st.status === 'running') { console.error(`goal ${g.name} is running; stop it first`); return 2; }
    const reg = registry(); delete reg[g.name]; setRegistry(reg);
    console.log(`goal ${g.name} removed from the list (files kept in ${g.dir})`);
    return 0;
  }
  if (sub === 'resume') {
    if (g.st.status === 'running') { console.log(`goal ${g.name} is already running`); return 0; }
    const L = { ...g.st.limits };
    if (f['max-rounds']) L.max_rounds = Number(f['max-rounds']);
    if (f['max-hours']) L.max_hours = Number(f['max-hours']);
    if (f['no-progress']) L.no_progress_rounds = Number(f['no-progress']);
    if ((g.st.round || 0) >= L.max_rounds) L.max_rounds = (g.st.round || 0) + G.max_rounds;
    const restartClock = Date.now() - Date.parse(g.st.started) > L.max_hours * 3600e3;
    patchState(g.dir, { status: 'running', stop_reason: null, ended: null, no_progress: 0, errors: 0, backoff_until: null, limits: L, ...(restartClock ? { started: now() } : {}) });
    await emit(cfg, g.name, 'goal.resumed', { text: `resumed by owner (limits ${L.max_rounds} rounds / ${L.max_hours} h)` });
    console.log(`goal ${g.name}: running again`);
    if (!daemonLoaded()) console.log('note: the goal runner is not running — gwmcp start goals');
    return 0;
  }
  console.error(HELP); return 2;
}
