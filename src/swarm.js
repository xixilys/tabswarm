// Swarm: one goal split into a plan of sub-tasks that run in parallel on several backends — web
// chats (ChatGPT / Gemini, any account), a model gateway, local agents — with a concurrency cap,
// retries that rotate through fallback backends, dependencies between steps, a final synthesis,
// live status, cancel and resume.
//
// State: STATE_DIR/swarms/<id>/
//   plan.json         the plan as submitted (see normalizePlan)
//   state.json        runner bookkeeping (atomic writes; read by `swarm status`, the MCP tools, `ps`)
//   tasks/<tid>/      prompt-<n>.txt, result-<n>.json, log-<n>.txt per attempt; answer.md when done
//   final.md          synthesis (or the concatenated answers)
// The runner (`webhub swarm __run <id>`) is a detached process; every attempt is its own detached
// `webhub ask ... --result-file` child, so a runner restart re-adopts running attempts.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { STATE_DIR, loadConfig, newId } from './config.js';
import { makeApi } from './client.js';
import { parseTarget, targetLabel } from './targets.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const CLI_BIN = path.join(HERE, '..', 'bin', 'webhub.mjs');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => new Date().toISOString();
const ID_RE = /^sw_[0-9a-f]{6,16}$/;
const TERMINAL = ['done', 'failed', 'cancelled', 'skipped'];

export const SWARM_DEFAULTS = {
  concurrency: 4,        // sub-tasks running at once in one swarm (web tasks also wait for the hub's per-account slots)
  max_retries: 2,        // extra attempts per sub-task; each retry moves to the next backend in [backend, ...fallback]
  retry_backoff_sec: 15,
  timeout_sec: 1800,     // per attempt
  max_tasks: 24,
  max_active: 6,         // swarms running at once
  max_depth: 2,          // a web agent inside a swarm may start a swarm; its agents may not
  result_chars: 4000,    // answer chars carried into dependent prompts and the synthesis
  default_backend: null, // null = config.default_target or web:gemini
};
export function swarmCfg(cfg) { return { ...SWARM_DEFAULTS, ...(cfg.swarm || {}) }; }

export const swarmsDir = () => path.join(STATE_DIR, 'swarms');
export const swarmDir = (id) => { if (!ID_RE.test(String(id))) throw Object.assign(new Error(`bad swarm id "${id}"`), { usage: true }); return path.join(swarmsDir(), id); };
function readJson(p, d = null) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return d; } }
function writeJson(p, v) { const t = `${p}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 7)}`; fs.writeFileSync(t, JSON.stringify(v, null, 2) + '\n', { mode: 0o600 }); fs.renameSync(t, p); }
export function loadSwarm(id) { return readJson(path.join(swarmDir(id), 'state.json')); }
function pidAlive(pid) { if (!pid) return false; try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } }
const clip = (s, n) => { s = String(s ?? ''); return s.length > n ? s.slice(0, n) + `\n…[+${s.length - n} chars]` : s; };

// ---------------------------------------------------------------- plan
// { title, goal, cwd, concurrency, max_retries, timeout_sec, defaults: {backend, fallback, account},
//   tasks: [{ id, title, prompt, backend, fallback: [], depends_on: [], cwd, account, session, timeout_sec }],
//   synthesize: false | true | { backend, prompt } }
export function normalizePlan(plan, cfg, { depth = 0, from = null } = {}) {
  const sc = swarmCfg(cfg);
  if (!plan || typeof plan !== 'object') throw Object.assign(new Error('plan must be a JSON object'), { usage: true });
  const tasks = Array.isArray(plan.tasks) ? plan.tasks : [];
  if (!tasks.length) throw Object.assign(new Error('plan has no tasks'), { usage: true });
  if (tasks.length > sc.max_tasks) throw Object.assign(new Error(`plan has ${tasks.length} tasks; the limit is swarm.max_tasks = ${sc.max_tasks}`), { usage: true });
  const d = plan.defaults || {};
  const defBackend = d.backend || plan.backend || sc.default_backend || cfg.default_target || 'web:gemini';
  const ids = new Set();
  const out = tasks.map((t, i) => {
    const id = String(t.id || `t${i + 1}`).replace(/[^\w.-]/g, '_').slice(0, 40);
    if (ids.has(id)) throw Object.assign(new Error(`duplicate task id "${id}"`), { usage: true });
    ids.add(id);
    const prompt = String(t.prompt || '').trim();
    if (!prompt) throw Object.assign(new Error(`task "${id}" has no prompt`), { usage: true });
    const backend = t.backend || defBackend;
    const fallback = (Array.isArray(t.fallback) ? t.fallback : Array.isArray(d.fallback) ? d.fallback : []).map(String);
    for (const b of [backend, ...fallback]) parseTarget(b, cfg); // validates
    return {
      id, title: String(t.title || prompt.split('\n')[0]).slice(0, 120), prompt, backend, fallback,
      depends_on: (t.depends_on || []).map(String), cwd: t.cwd || plan.cwd || null, account: t.account || d.account || null,
      session: t.session || null, timeout_sec: Number(t.timeout_sec || plan.timeout_sec || sc.timeout_sec),
      status: 'pending', attempts: [], next_at: null, answer_preview: '', error: null,
    };
  });
  for (const t of out) for (const dep of t.depends_on) if (!ids.has(dep)) throw Object.assign(new Error(`task "${t.id}" depends on unknown "${dep}"`), { usage: true });
  // cycle check
  const seen = new Map();
  const visit = (id, stack = []) => {
    if (seen.get(id) === 2) return; if (seen.get(id) === 1) throw Object.assign(new Error(`dependency cycle: ${[...stack, id].join(' -> ')}`), { usage: true });
    seen.set(id, 1); for (const dep of out.find((x) => x.id === id).depends_on) visit(dep, [...stack, id]); seen.set(id, 2);
  };
  out.forEach((t) => visit(t.id));
  let synth = plan.synthesize ?? (out.length > 1);
  if (synth === true) synth = {};
  if (synth) { synth = { backend: synth.backend || plan.synthesizer || defBackend, prompt: synth.prompt || '' }; parseTarget(synth.backend, cfg); }
  return {
    title: String(plan.title || plan.goal || out[0].title).slice(0, 160), goal: String(plan.goal || ''), cwd: plan.cwd || null,
    concurrency: Math.max(1, Math.min(Number(plan.concurrency || sc.concurrency), 32)),
    max_retries: Math.max(0, Math.min(Number(plan.max_retries ?? sc.max_retries), 6)),
    tasks: out, synthesize: synth || false, depth, from,
  };
}

// ---------------------------------------------------------------- create / control
export function listSwarms() {
  try {
    return fs.readdirSync(swarmsDir()).filter((x) => ID_RE.test(x)).map((x) => loadSwarm(x)).filter(Boolean)
      .sort((a, b) => String(b.created).localeCompare(String(a.created)));
  } catch { return []; }
}
export const activeSwarms = () => listSwarms().filter((s) => s.status === 'running');

export function createSwarm(plan, cfg, opts = {}) {
  const sc = swarmCfg(cfg);
  const norm = normalizePlan(plan, cfg, opts);
  if (norm.depth > sc.max_depth) throw Object.assign(new Error(`swarm depth ${norm.depth} exceeds swarm.max_depth = ${sc.max_depth} (agents started by a swarm may not start more swarms)`), { denied: true });
  if (activeSwarms().length >= sc.max_active) throw Object.assign(new Error(`${sc.max_active} swarms are already running (swarm.max_active); wait or cancel one`), { denied: true });
  const id = newId('sw', 4);
  const dir = path.join(swarmsDir(), id);
  fs.mkdirSync(path.join(dir, 'tasks'), { recursive: true, mode: 0o700 });
  writeJson(path.join(dir, 'plan.json'), plan);
  const st = { id, ...norm, status: 'running', created: now(), updated: now(), ended: null, runner_pid: null, final: null, extra: opts.extra || {} };
  writeJson(path.join(dir, 'state.json'), st);
  return st;
}

export function startRunner(id, { env = process.env, extraArgs = [] } = {}) {
  const dir = swarmDir(id);
  const out = fs.openSync(path.join(dir, 'runner.log'), 'a');
  const ch = spawn(process.execPath, [CLI_BIN, 'swarm', '__run', id, ...extraArgs], { detached: true, stdio: ['ignore', out, out], env });
  ch.unref(); fs.closeSync(out);
  return ch.pid;
}

// The runner owns state.json; others ask it to change things through control.json.
function control(id, patch) {
  const p = path.join(swarmDir(id), 'control.json');
  const c = readJson(p, {});
  writeJson(p, { ...c, ...patch, at: now() });
}
export function cancelSwarm(id) {
  const st = loadSwarm(id); if (!st) return null;
  control(id, { cancel: true });
  if (!pidAlive(st.runner_pid) && st.status === 'running') { // no runner: settle it here
    for (const t of st.tasks) { const a = t.attempts.slice(-1)[0]; if (a?.pid && pidAlive(a.pid)) try { process.kill(-a.pid, 'SIGTERM'); } catch { /* gone */ } if (!TERMINAL.includes(t.status)) t.status = 'cancelled'; }
    st.status = 'cancelled'; st.ended = now(); st.updated = now(); writeJson(path.join(swarmDir(id), 'state.json'), st);
  }
  return st;
}
export function retrySwarm(id, taskIds = null) {
  const st = loadSwarm(id); if (!st) return null;
  control(id, { retry: taskIds && taskIds.length ? taskIds : st.tasks.filter((t) => ['failed', 'skipped', 'cancelled'].includes(t.status)).map((t) => t.id) });
  return st;
}
export function resumeSwarm(id, opts = {}) {
  const st = loadSwarm(id); if (!st) return null;
  if (pidAlive(st.runner_pid)) return { ...st, note: 'runner already running' };
  if (st.status !== 'running') {
    st.status = 'running'; st.ended = null;
    for (const t of st.tasks) if (['failed', 'skipped', 'cancelled'].includes(t.status)) { t.status = 'pending'; t.next_at = null; t.attempts_base = t.attempts.length; }
    writeJson(path.join(swarmDir(id), 'state.json'), st);
  }
  try { fs.rmSync(path.join(swarmDir(id), 'control.json')); } catch { /* none */ }
  startRunner(id, opts);
  return loadSwarm(id);
}

// Compact view for the CLI, the MCP tools and the dashboard.
export function swarmSummary(st, { answers = false, chars = 600 } = {}) {
  if (!st) return null;
  const counts = {}; for (const t of st.tasks) counts[t.status] = (counts[t.status] || 0) + 1;
  return {
    id: st.id, title: st.title, status: st.status, created: st.created, updated: st.updated, ended: st.ended, concurrency: st.concurrency,
    counts, total: st.tasks.length, runner_alive: pidAlive(st.runner_pid), depth: st.depth || 0,
    tasks: st.tasks.map((t) => {
      const a = t.attempts.slice(-1)[0];
      return {
        id: t.id, title: t.title, status: t.status, backend: a?.target || t.backend, attempts: t.attempts.length, depends_on: t.depends_on,
        web_task: a?.task_id || null, agent_id: a?.agent_id || null, chat_url: a?.chat_url || null, tool_calls: a?.tool_calls || 0,
        elapsed_sec: a ? Math.round(((a.ended ? Date.parse(a.ended) : Date.now()) - Date.parse(a.started)) / 1000) : 0,
        error: t.status === 'done' ? null : (t.error || null),
        ...(answers ? { answer: clip(readAnswer(st.id, t.id), chars) } : { answer_preview: clip(t.answer_preview, 160) }),
      };
    }),
    final: st.final ? { status: st.final.status, path: path.join(swarmDir(st.id), 'final.md'), ...(answers ? { text: clip(readMaybe(path.join(swarmDir(st.id), 'final.md')), chars * 4) } : {}) } : null,
  };
}
const readMaybe = (p) => { try { return fs.readFileSync(p, 'utf8'); } catch { return ''; } };
export const readAnswer = (id, tid) => readMaybe(path.join(swarmDir(id), 'tasks', tid, 'answer.md'));

// ---------------------------------------------------------------- runner
export async function runSwarm(id, { cfg = loadConfig(), pollMs = 1000, env = process.env, childArgs = [] } = {}) {
  const dir = swarmDir(id);
  const lock = path.join(dir, 'runner.pid');
  const other = Number(readMaybe(lock));
  if (other && other !== process.pid && pidAlive(other)) { console.error(`swarm ${id}: runner ${other} is already running`); return 0; }
  fs.writeFileSync(lock, String(process.pid));
  let st = loadSwarm(id);
  if (!st) { console.error(`swarm ${id}: no state`); return 2; }
  st.runner_pid = process.pid; st.updated = now(); save();
  const sc = swarmCfg(cfg);
  const api = makeApi({ cfg });
  const pending = new Set();
  const emit = (type, data) => { const pr = api('/swarms/event', { method: 'POST', body: { swarm_id: id, type, ...data } }).catch(() => {}); pending.add(pr); pr.finally(() => pending.delete(pr)); return pr; };
  emit('swarm.started', { title: st.title, tasks: st.tasks.length, text: `swarm ${id} running ${st.tasks.length} tasks: ${st.title}` });
  let stopping = false;
  const onSig = () => { stopping = true; };
  process.on('SIGTERM', onSig); process.on('SIGINT', onSig);

  function save() { st.updated = now(); writeJson(path.join(dir, 'state.json'), st); }
  const tdir = (t) => { const p = path.join(dir, 'tasks', t.id); fs.mkdirSync(p, { recursive: true }); return p; };
  const targets = (t) => [t.backend, ...(t.fallback || [])];

  function promptFor(t) {
    const deps = t.depends_on.map((d) => st.tasks.find((x) => x.id === d)).filter(Boolean);
    const parts = [];
    if (st.goal) parts.push(`Overall goal (you do one part of it):\n${st.goal}`);
    parts.push(t.prompt);
    if (deps.length) parts.push(`Results of the steps this one builds on:\n${deps.map((x) => `### ${x.id}: ${x.title}\n${clip(readAnswer(id, x.id), sc.result_chars)}`).join('\n\n')}`);
    return parts.join('\n\n');
  }

  function launch(t, { synth = false } = {}) {
    const n = t.attempts.length + 1;
    const list = targets(t);
    const target = list[(n - 1 - (t.attempts_base || 0)) % list.length];
    const d = tdir(t);
    const pf = path.join(d, `prompt-${n}.txt`), rf = path.join(d, `result-${n}.json`), lf = path.join(d, `log-${n}.txt`);
    fs.writeFileSync(pf, synth ? t.prompt : promptFor(t), { mode: 0o600 });
    const args = ['ask', '--backend', target, '-f', pf, '--result-file', rf, '--timeout', String(t.timeout_sec || sc.timeout_sec), '--from', `swarm:${id}`, '--title', `${st.title.slice(0, 60)} · ${t.title}`.slice(0, 120)];
    const cwd = t.cwd || st.cwd;
    if (cwd) args.push('--cwd', cwd);
    if (t.account && parseTarget(target, cfg).kind === 'web') args.push('--account', t.account);
    if (t.session) args.push('--session', t.session);
    args.push(...childArgs);
    const out = fs.openSync(lf, 'a');
    const ch = spawn(process.execPath, [CLI_BIN, ...args], { detached: true, stdio: ['ignore', out, out], env: { ...env, TABSWARM_SWARM_ID: id, TABSWARM_DEPTH: String((st.depth || 0) + 1) }, cwd: cwd && fs.existsSync(cwd) ? cwd : os.homedir() });
    ch.unref(); fs.closeSync(out);
    t.attempts.push({ n, target, pid: ch.pid, started: now(), ended: null, result_file: rf, log_file: lf, status: 'running' });
    t.status = 'running'; t.next_at = null;
    emit('swarm.task_start', { task: t.id, target, attempt: n, text: `${id}/${t.id} attempt ${n} on ${target}: ${t.title}` });
  }

  function settle(t, a, r) {
    a.ended = now(); a.status = r.ok ? 'done' : (r.status || 'failed'); a.exit_code = r.exit_code ?? null;
    a.task_id = r.task_id || null; a.agent_id = r.agent_id || null; a.chat_url = r.chat_url || null; a.tool_calls = r.tool_calls || 0; a.error = r.ok ? null : (r.error || r.status || 'failed');
    if (r.ok) {
      fs.writeFileSync(path.join(tdir(t), 'answer.md'), r.answer || '');
      t.status = 'done'; t.answer_preview = String(r.answer || '').slice(0, 400); t.error = null;
      emit('swarm.task_end', { task: t.id, status: 'done', target: a.target, attempt: a.n, text: `${id}/${t.id} done on ${a.target}` });
      return;
    }
    t.error = a.error;
    const used = t.attempts.length - (t.attempts_base || 0);
    if (r.exit_code === 2 || used > st.max_retries || t.id === '__synth' && used > 1) {
      t.status = 'failed';
      emit('swarm.task_end', { task: t.id, status: 'failed', target: a.target, attempt: a.n, error: a.error, text: `${id}/${t.id} failed after ${used} attempt(s): ${String(a.error).slice(0, 200)}` });
    } else {
      t.status = 'pending'; t.next_at = new Date(Date.now() + sc.retry_backoff_sec * 1000 * used).toISOString();
      emit('swarm.task_retry', { task: t.id, after_sec: sc.retry_backoff_sec * used, error: a.error, text: `${id}/${t.id} attempt ${a.n} on ${a.target} failed (${String(a.error).slice(0, 160)}); retrying on ${targets(t)[(used) % targets(t).length]}` });
    }
  }

  function poll(t) {
    const a = t.attempts.slice(-1)[0];
    if (!a || a.ended) return;
    const r = readJson(a.result_file);
    if (r) return settle(t, a, r);
    if (!pidAlive(a.pid)) return settle(t, a, { ok: false, status: 'lost', error: `attempt process exited without a result (log: ${a.log_file})` });
    if (Date.now() - Date.parse(a.started) > ((t.timeout_sec || sc.timeout_sec) + 300) * 1000) {
      try { process.kill(-a.pid, 'SIGTERM'); } catch { /* gone */ }
      return settle(t, a, { ok: false, status: 'timeout', error: 'attempt exceeded its time limit' });
    }
  }

  function applyControl() {
    const p = path.join(dir, 'control.json');
    const c = readJson(p); if (!c) return false;
    fs.rmSync(p, { force: true });
    if (c.cancel) return 'cancel';
    if (Array.isArray(c.retry)) for (const tid of c.retry) {
      const t = st.tasks.find((x) => x.id === tid);
      if (t && ['failed', 'skipped', 'cancelled'].includes(t.status)) { t.status = 'pending'; t.next_at = null; t.attempts_base = t.attempts.length; t.error = null; }
    }
    if (c.retry && st.final) { st.final = null; st.tasks = st.tasks.filter((t) => t.id !== '__synth'); }
    return false;
  }

  function finalize() {
    const real = st.tasks.filter((t) => t.id !== '__synth');
    const done = real.filter((t) => t.status === 'done');
    const synthT = st.tasks.find((t) => t.id === '__synth');
    let text;
    if (synthT?.status === 'done') text = readAnswer(id, '__synth');
    else text = real.map((t) => `## ${t.id}: ${t.title} — ${t.status}\n\n${t.status === 'done' ? readAnswer(id, t.id) : `(${t.error || t.status})`}`).join('\n\n');
    fs.writeFileSync(path.join(dir, 'final.md'), `# ${st.title}\n\n${text}\n`);
    st.final = { status: done.length === real.length ? 'complete' : done.length ? 'partial' : 'failed', synthesized: synthT?.status === 'done', at: now() };
    st.status = done.length === real.length ? 'done' : done.length ? 'partial' : 'failed';
    st.ended = now();
    emit('swarm.end', { status: st.status, done: done.length, total: real.length, text: `swarm ${id} ${st.status}: ${done.length}/${real.length} tasks done${st.final.synthesized ? ', synthesized' : ''}` });
  }

  try {
    while (!stopping) {
      if (applyControl() === 'cancel') {
        for (const t of st.tasks) {
          const a = t.attempts.slice(-1)[0];
          if (a && !a.ended && pidAlive(a.pid)) try { process.kill(-a.pid, 'SIGTERM'); } catch { /* gone */ }
          if (a && !a.ended) { a.ended = now(); a.status = 'cancelled'; }
          if (!TERMINAL.includes(t.status)) t.status = 'cancelled';
        }
        st.status = 'cancelled'; st.ended = now(); save();
        emit('swarm.end', { status: 'cancelled', text: `swarm ${id} cancelled` });
        break;
      }
      for (const t of st.tasks) if (t.status === 'running') poll(t);
      // dependencies that failed make their dependents skipped
      for (const t of st.tasks) if (t.status === 'pending' && t.depends_on.some((d) => ['failed', 'skipped', 'cancelled'].includes(st.tasks.find((x) => x.id === d)?.status))) { t.status = 'skipped'; t.error = 'a step it depends on did not finish'; }
      const running = st.tasks.filter((t) => t.status === 'running').length;
      let free = st.concurrency - running;
      for (const t of st.tasks) {
        if (free <= 0) break;
        if (t.status !== 'pending' || t.id === '__synth') continue;
        if (t.next_at && Date.parse(t.next_at) > Date.now()) continue;
        if (!t.depends_on.every((d) => st.tasks.find((x) => x.id === d)?.status === 'done')) continue;
        launch(t); free--;
      }
      const real = st.tasks.filter((t) => t.id !== '__synth');
      if (real.every((t) => TERMINAL.includes(t.status))) {
        const synthT = st.tasks.find((t) => t.id === '__synth');
        const anyDone = real.some((t) => t.status === 'done');
        if (st.synthesize && anyDone && !synthT) {
          const prompt = [
            `You are combining the results of ${real.length} parallel sub-tasks into one answer.`,
            st.goal ? `Goal:\n${st.goal}` : `Title: ${st.title}`,
            st.synthesize.prompt || 'Merge them into one coherent, deduplicated answer. Point out disagreements between sub-tasks and anything still missing. Do not invent results.',
            real.map((t) => `### ${t.id}: ${t.title} — ${t.status}\n${t.status === 'done' ? clip(readAnswer(id, t.id), sc.result_chars) : `(not finished: ${t.error || t.status})`}`).join('\n\n'),
          ].join('\n\n');
          const s = { id: '__synth', title: 'synthesis', prompt, backend: st.synthesize.backend, fallback: [], depends_on: [], cwd: st.cwd, status: 'pending', attempts: [], timeout_sec: sc.timeout_sec };
          st.tasks.push(s); launch(s, { synth: true });
        } else if (!synthT || TERMINAL.includes(synthT.status)) { finalize(); save(); break; }
        else if (synthT.status === 'running') poll(synthT);
        else if (synthT.status === 'pending' && (!synthT.next_at || Date.parse(synthT.next_at) <= Date.now())) launch(synthT, { synth: true });
      }
      save();
      await sleep(pollMs);
    }
  } finally {
    process.off('SIGTERM', onSig); process.off('SIGINT', onSig);
    if (stopping && st.status === 'running') { save(); } // attempts keep running; `swarm resume` re-adopts them
    try { if (Number(readMaybe(lock)) === process.pid) fs.rmSync(lock); } catch { /* ignore */ }
    await Promise.race([Promise.allSettled([...pending]), sleep(5000)]); // deliver the last events before exiting
  }
  return 0;
}

// ---------------------------------------------------------------- planner
export function plannerPrompt({ goal, workers, maxTasks, cwd, extra }) {
  return `Plan how to get this goal done by up to ${maxTasks} workers running IN PARALLEL. Each worker is a separate AI session that only sees its own prompt (plus the results of the steps it depends on).
${cwd ? `Working directory: ${cwd}\n` : ''}Available worker backends: ${workers.join(', ')}.
Rules: split into independent parts where you can; use depends_on only when a part truly needs another's result; every prompt must be complete and self-contained (what to do, where, what to hand back); prefer fewer, meatier tasks over many tiny ones.${extra ? `\n${extra}` : ''}
Reply with ONLY a JSON object, no prose, in this shape:
{"title": "...", "tasks": [{"id": "short-id", "title": "...", "prompt": "...", "backend": "<one of the backends>", "depends_on": []}]}

GOAL:
${goal}`;
}

export function parsePlanJson(text) {
  const s = String(text || '');
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(s);
  const cands = [fenced?.[1], s];
  for (const c of cands) {
    if (!c) continue;
    const i = c.indexOf('{'), j = c.lastIndexOf('}');
    if (i < 0 || j <= i) continue;
    try { const o = JSON.parse(c.slice(i, j + 1)); if (o && Array.isArray(o.tasks)) return o; } catch { /* next */ }
  }
  throw new Error('the planner did not return a JSON plan with a "tasks" array');
}

// ---------------------------------------------------------------- CLI
function fmtSummary(s) {
  const c = s.counts;
  const lines = [`${s.id}  ${s.status}${s.runner_alive ? '' : s.status === 'running' ? '  (runner not running: swarm resume ' + s.id + ')' : ''}  ${s.title}`,
    `  ${s.total} tasks: ${Object.entries(c).map(([k, v]) => `${k} ${v}`).join(', ')}  concurrency ${s.concurrency}`];
  for (const t of s.tasks) lines.push(`  ${t.status.padEnd(9)} ${t.id.padEnd(14)} ${String(t.backend).padEnd(28)} try ${t.attempts}  ${t.elapsed_sec}s${t.tool_calls ? `  ${t.tool_calls} calls` : ''}${t.web_task ? `  ${t.web_task}` : ''}${t.agent_id ? `  ${t.agent_id}` : ''}  ${t.title}${t.error ? `\n            ↳ ${String(t.error).split('\n')[0].slice(0, 160)}` : ''}`);
  if (s.final) lines.push(`  final: ${s.final.status} → ${s.final.path}`);
  return lines.join('\n');
}

export async function swarmCli(args, flags) {
  const cfg = loadConfig();
  const sub = args[0];
  const childArgs = flags.driver ? ['--driver', flags.driver] : [];
  const json = (o) => console.log(JSON.stringify(o, null, 2));
  const start = (plan, extra = {}) => {
    if (flags.concurrency) plan.concurrency = Number(flags.concurrency);
    if (flags.retries != null) plan.max_retries = Number(flags.retries);
    if (flags.cwd && !plan.cwd) plan.cwd = flags.cwd;
    const depth = Number(process.env.TABSWARM_DEPTH || 0);
    const st = createSwarm(plan, cfg, { depth, from: flags.from, extra });
    startRunner(st.id, { extraArgs: childArgs });
    return st;
  };
  if (sub === 'start' || sub === 'submit') {
    const f = args[1] || flags.file;
    if (!f) { console.error('usage: webhub swarm start <plan.json|-> [--concurrency N] [--retries N] [--wait] [--json]'); return 2; }
    const plan = JSON.parse(fs.readFileSync(f === '-' ? 0 : f, 'utf8'));
    const st = start(plan);
    if (flags.waitResult) return waitAndPrint(st.id, flags);
    if (flags.json) json({ swarm_id: st.id, status: st.status, tasks: st.tasks.length }); else console.log(st.id);
    return 0;
  }
  if (sub === 'run') {
    // quick form: webhub swarm run --backend a,b "prompt 1" "prompt 2" ...  (one task per prompt)
    const prompts = args.slice(1);
    if (!prompts.length) { console.error('usage: webhub swarm run [--backend spec1,spec2] [--fallback spec] "prompt 1" "prompt 2" ...'); return 2; }
    const backs = String(flags.backend || '').split(',').filter(Boolean);
    const plan = { title: flags.title || prompts[0].slice(0, 80), goal: flags.goal || '', tasks: prompts.map((p, i) => ({ id: `t${i + 1}`, prompt: p, ...(backs.length ? { backend: backs[i % backs.length] } : {}), ...(flags.fallback ? { fallback: String(flags.fallback).split(',') } : {}) })), synthesize: flags.synth ? { backend: flags.synth } : prompts.length > 1 };
    const st = start(plan);
    if (flags.wait === false) { if (flags.json) json({ swarm_id: st.id }); else console.log(st.id); return 0; }
    return waitAndPrint(st.id, flags);
  }
  if (sub === 'plan') {
    const goal = flags.file ? fs.readFileSync(flags.file, 'utf8') : args.slice(1).join(' ');
    if (!goal.trim()) { console.error('usage: webhub swarm plan "goal" [--planner SPEC] [--workers spec1,spec2] [--max-tasks N] [--cwd DIR] [--run] [--synth SPEC]'); return 2; }
    const workers = String(flags.workers || cfg.swarm?.workers || 'web:chatgpt,web:gemini').split(',').map((x) => x.trim()).filter(Boolean);
    for (const w of workers) parseTarget(w, cfg);
    const { ask } = await import('./ask.js');
    const planner = flags.planner || cfg.swarm?.planner || workers[0];
    process.stderr.write(`[swarm] asking ${planner} for a plan…\n`);
    const r = await ask({ prompt: plannerPrompt({ goal, workers, maxTasks: Number(flags.maxTasks || 6), cwd: flags.cwd }), backend: planner, cwd: flags.cwd, timeoutSec: flags.timeout || 900, from: 'swarm-planner', driver: flags.driver, cfg });
    if (!r.ok) { console.error(`swarm plan: the planner failed: ${r.error || r.status}`); return 4; }
    const plan = parsePlanJson(r.answer);
    plan.goal = goal; if (flags.cwd) plan.cwd = flags.cwd;
    plan.tasks = plan.tasks.slice(0, Number(flags.maxTasks || 6)).map((t, i) => ({ ...t, backend: workers.includes(t.backend) ? t.backend : workers[i % workers.length] }));
    if (flags.synth) plan.synthesize = { backend: flags.synth };
    else if (plan.synthesize === undefined) plan.synthesize = { backend: planner };
    plan.planner = planner;
    if (!flags.run) { json(plan); return 0; }
    const st = start(plan, { planner });
    if (flags.waitResult) return waitAndPrint(st.id, flags);
    if (flags.json) json({ swarm_id: st.id, tasks: st.tasks.length, plan }); else { console.log(st.id); process.stderr.write(fmtSummary(swarmSummary(loadSwarm(st.id))) + '\n'); }
    return 0;
  }
  if (sub === '__run') return runSwarm(args[1], { cfg, childArgs }); // the CLI parsed --driver into flags.driver
  if (!sub || sub === 'list' || sub === 'ls') {
    const all = listSwarms().slice(0, 30).map((s) => swarmSummary(s));
    if (flags.json) json(all); else if (!all.length) console.log('no swarms yet'); else for (const s of all) console.log(`${s.id}  ${s.status.padEnd(9)} ${String(s.counts.done || 0)}/${s.total} done  ${s.created.slice(0, 16).replace('T', ' ')}  ${s.title}`);
    return 0;
  }
  const id = args[1];
  if (!id) { console.error(`usage: webhub swarm ${sub} <swarm_id>`); return 2; }
  if (!loadSwarm(id)) { console.error(`no swarm ${id}`); return 2; }
  if (sub === 'status') {
    if (flags.watch) { for (;;) { const s = swarmSummary(loadSwarm(id)); process.stdout.write('\x1b[2J\x1b[H' + fmtSummary(s) + '\n'); if (s.status !== 'running') return 0; await sleep((flags.interval || 2) * 1000); } }
    const s = swarmSummary(loadSwarm(id), { answers: !!flags.answers });
    if (flags.json) json(s); else console.log(fmtSummary(s));
    return 0;
  }
  if (sub === 'result') {
    if (flags.waitResult) return waitAndPrint(id, flags);
    const st = loadSwarm(id);
    if (!st.final) { console.error(`swarm ${id} has no final result yet (${st.status})`); return 4; }
    if (flags.json) json(swarmSummary(st, { answers: true, chars: 100000 })); else process.stdout.write(readMaybe(path.join(swarmDir(id), 'final.md')));
    return st.status === 'done' ? 0 : 3;
  }
  if (sub === 'cancel') { cancelSwarm(id); console.log(`cancelling ${id}`); return 0; }
  if (sub === 'retry') { retrySwarm(id, args.slice(2)); const st = loadSwarm(id); if (!pidAlive(st.runner_pid)) resumeSwarm(id, { extraArgs: childArgs }); console.log(`retrying ${args.slice(2).join(', ') || 'failed tasks'} in ${id}`); return 0; }
  if (sub === 'resume') { const st = resumeSwarm(id, { extraArgs: childArgs }); console.log(st.note ? `${id}: ${st.note}` : `resumed ${id}`); return 0; }
  console.error('usage: webhub swarm [list|plan|start|run|status|result|cancel|retry|resume] ...');
  return 2;
}

async function waitAndPrint(id, flags) {
  const deadline = Date.now() + (flags.timeout ? flags.timeout * 1000 : 6 * 3600e3);
  let lastLine = '';
  for (;;) {
    const st = loadSwarm(id);
    const s = swarmSummary(st);
    const line = `${s.status} ${Object.entries(s.counts).map(([k, v]) => `${k}=${v}`).join(' ')}`;
    if (line !== lastLine) { process.stderr.write(`[swarm ${id}] ${line}\n`); lastLine = line; }
    if (st.status !== 'running') break;
    if (Date.now() > deadline) { process.stderr.write(`[swarm ${id}] still running; check later: webhub swarm status ${id}\n`); return 4; }
    await sleep(1500);
  }
  const st = loadSwarm(id);
  if (flags.json) console.log(JSON.stringify(swarmSummary(st, { answers: true, chars: 100000 }), null, 2));
  else process.stdout.write(readMaybe(path.join(swarmDir(id), 'final.md')));
  return st.status === 'done' ? 0 : st.status === 'partial' ? 3 : 4;
}
