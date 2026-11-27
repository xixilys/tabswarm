// `ask`: send one prompt to one target and give back only the answer. This is the stable entry
// point for other agents and schedulers (Claude Code, Codex, agy, `cmd:`-style scheduler providers):
//   stdin/-f/words = prompt, stdout = answer, stderr = progress + details, exit code = outcome
//   (0 answered, 2 usage, 3 blocked, 4 timeout/failed, 5 hub not running).
// Targets (src/targets.js): web:gemini / web:chatgpt (a real web chat through the hub), gateway
// (HTTP model gateway), or a local agent backend (claude, codex, ... started by the hub).
// --session NAME keeps a conversation across calls (src/sessions.js).
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from './config.js';
import { makeApi, waitFinal, answerOf, detailsOf } from './client.js';
import { targetFrom, targetLabel } from './targets.js';
import { gatewayChat } from './gateway.js';
import { loadSession, saveSession, newSession, withSessionLock, needsRollover, handoffPrompt, recordWebTurn, sessionCfg } from './sessions.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const readMaybe = (p) => { try { return fs.readFileSync(p, 'utf8'); } catch { return null; } };

export const EXIT = { ok: 0, usage: 2, blocked: 3, failed: 4, unreachable: 5 };

// ---------------------------------------------------------------- web (ChatGPT / Gemini)
async function askWebOnce({ prompt, t, cwd, chat, account, timeoutSec, opts, cfg, api }) {
  const { dispatch } = await import('./driver.js');
  let captured = null;
  const flags = {
    site: t.site, account: account || null, model: chat ? null : t.model, effort: chat ? null : t.effort, chat: chat || null, cwd: cwd || null,
    from: opts.from || process.env.WEBHUB_FROM || 'ask', timeout: timeoutSec, title: opts.title, wait: true,
    noOperator: opts.noOperator !== false, driver: opts.driver, allowPro: !!opts.allowPro, keepTab: !!opts.keepTab,
  };
  // driver.js prints blocked/timeout notes with console.log; keep stdout for the answer only.
  const origLog = console.log;
  const notes = [];
  console.log = (...a) => { const line = a.join(' '); notes.push(line); process.stderr.write(line + '\n'); };
  let code, createdId = null;
  // remember the id of the task dispatch() creates (it is not returned on timeout/failure)
  const tapi = async (p, o = {}) => { const res = await api(p, o); if (p === '/tasks' && o.method === 'POST' && res?.id) createdId = res.id; return res; };
  try {
    code = await dispatch({ task: prompt, flags, api: tapi, waitFinal: (id, sec, o) => waitFinal(tapi, id, sec, o), printFinal: (task) => { captured = task; }, cfg });
  } finally { console.log = origLog; }
  const id = captured?.id || createdId;
  const task = id ? await api(`/tasks/${id}`).catch(() => captured) : captured;
  if (task && captured?.tool_summary) task.tool_summary = captured.tool_summary;
  return { code, task, note: notes.join('\n').slice(-800) };
}

async function askWeb({ prompt, t, opts, cfg, api }) {
  const sc = sessionCfg(cfg);
  const maxCont = opts.maxContinue ?? cfg.sessions?.max_continue ?? 2;
  const run = async (s) => {
    let chat = opts.chat || s?.chat_url || null;
    let text = prompt, rolled = false;
    if (s && !opts.chat && needsRollover(s, cfg)) { text = handoffPrompt(s, prompt, cfg); chat = null; rolled = true; process.stderr.write(`[ask] session "${s.name}": chat used ${s.chat_tool_calls} tool calls (budget ${sc.max_tool_calls[t.site]}) — continuing in a new chat with a handoff summary\n`); }
    let r, continued = 0;
    for (;;) {
      r = await askWebOnce({ prompt: text, t, cwd: opts.cwd, chat, account: opts.account || (chat ? null : s?.account) || null, timeoutSec: opts.timeoutSec, opts, cfg, api });
      if (s && r.task) { recordWebTurn(s, { prompt: text, task: r.task, rolledOver: rolled }); saveSession(s); }
      const task = r.task;
      const cap = sc.max_tool_calls[t.site] ?? 80;
      // The model stopped without a final report after using most of the chat's tool budget:
      // carry on in a fresh chat instead of failing the task.
      const outOfBudget = task && !task.final && r.code === EXIT.failed && cap > 0 && (task.tool_calls || 0) >= Math.floor(cap * 0.75);
      if (!outOfBudget || continued >= maxCont) break;
      continued++;
      const tmp = s || { ...newSession('tmp', t), turns: [{ prompt, summary: '(see progress reports)' }] };
      const progress = (task.reports || []).filter((x) => x.status === 'progress').map((x) => x.summary).slice(-4).join('\n- ');
      text = handoffPrompt(tmp, `${prompt}\n\n${progress ? `Progress reported before the chat stopped:\n- ${progress}\n` : ''}`, cfg, { reason: `it stopped after ${task.tool_calls} tool calls without finishing` });
      chat = null; rolled = true;
      process.stderr.write(`[ask] ${task.id} stopped after ${task.tool_calls} tool calls without a final report — continuing in a new chat (${continued}/${maxCont})\n`);
    }
    return { ...r, continued };
  };
  const r = opts.session
    ? await withSessionLock(opts.session, async () => {
      let s = loadSession(opts.session);
      if (s && s.kind !== 'web') throw Object.assign(new Error(`session "${opts.session}" is a ${s.kind} session, not web`), { usage: true });
      if (s && s.site && s.site !== t.site) throw Object.assign(new Error(`session "${opts.session}" lives on ${s.site}, not ${t.site}`), { usage: true });
      if (!s) s = newSession(opts.session, t);
      return run(s);
    })
    : await run(null);
  const task = r.task;
  const status = task?.final ? (task.final.status === 'final' ? 'done' : 'blocked') : (r.code === EXIT.blocked ? 'blocked' : task?.status || 'failed');
  return {
    ok: r.code === 0 && !!task?.final, exit_code: r.code, status, answer: task ? answerOf(task) : '', details: task ? detailsOf(task) : '',
    task_id: task?.id || null, chat_url: task?.chat_url || null, account: task?.account || null, tool_calls: task?.tool_calls || 0,
    continued: r.continued, error: task?.final ? null : (task?.error || r.note || null), session: opts.session || null,
    retryable: !task?.final && r.code !== EXIT.usage,
  };
}

// ---------------------------------------------------------------- gateway
async function askGateway({ prompt, t, opts, cfg }) {
  const sc = sessionCfg(cfg);
  const once = async (history) => {
    const messages = [...history, { role: 'user', content: opts.cwd ? `Working directory: ${opts.cwd}\n\n${prompt}` : prompt }];
    const r = await gatewayChat({ cfg, gateway: t.gateway, model: t.model, effort: t.effort, messages, system: opts.system, timeoutSec: opts.timeoutSec });
    return { r, messages };
  };
  try {
    let out;
    if (opts.session) {
      out = await withSessionLock(opts.session, async () => {
        let s = loadSession(opts.session);
        if (s && s.kind !== 'gateway') throw Object.assign(new Error(`session "${opts.session}" is a ${s.kind} session, not gateway`), { usage: true });
        if (!s) s = newSession(opts.session, t);
        const { r, messages } = await once((s.history || []).slice(-2 * sc.history_turns));
        s.history = [...messages, { role: 'assistant', content: r.text }].slice(-2 * sc.history_turns);
        s.turns.push({ at: new Date().toISOString(), prompt: prompt.slice(0, 1500), summary: r.text.slice(0, 1200), model: r.model });
        s.turns = s.turns.slice(-50);
        saveSession(s);
        return r;
      });
    } else out = (await once([])).r;
    return { ok: !!out.text, exit_code: out.text ? 0 : EXIT.failed, status: out.text ? 'done' : 'failed', answer: out.text, details: `model: ${out.model}${out.usage ? `\nusage: ${JSON.stringify(out.usage)}` : ''}`, model: out.model, usage: out.usage, session: opts.session || null };
  } catch (e) {
    if (e.usage) throw e;
    return { ok: false, exit_code: EXIT.failed, status: 'failed', answer: '', details: '', error: e.message, retryable: e.retryable !== false };
  }
}

// ---------------------------------------------------------------- local agent (through the hub)
async function askAgent({ prompt, t, opts, cfg, api }) {
  const cwd = path.resolve(opts.cwd || process.cwd());
  const body = { target: 'agent', backend: t.backend, prompt, cwd, timeout_min: opts.timeoutSec ? Math.ceil(opts.timeoutSec / 60) : undefined, model: t.model || undefined, effort: t.effort || undefined };
  const r = await api('/dispatch', { method: 'POST', body });
  const id = r.agent_id;
  const dir = path.join(r.cwd || cwd, '.gemweb', 'agents', id);
  process.stderr.write(`AGENT_ID=${id}\n`);
  let stopped = false;
  const onSig = () => { if (stopped) return; stopped = true; api(`/agents/${id}/stop`, { method: 'POST', body: {} }).catch(() => {}).finally(() => process.exit(143)); };
  process.on('SIGTERM', onSig); process.on('SIGINT', onSig);
  const deadline = Date.now() + ((opts.timeoutSec || 3600) + 120) * 1000;
  let status = 'running', exit = null;
  try {
    while (Date.now() < deadline) {
      const code = readMaybe(path.join(dir, 'exit_code'));
      if (code !== null && code.trim() !== '') { exit = Number(code); status = exit === 0 ? 'done' : 'failed'; break; }
      const st = await api('/state').catch(() => null);
      const rec = (st?.agents?.recent || []).find((a) => a.id === id);
      if (rec && rec.status !== 'running') { status = rec.status; await sleep(1500); const c2 = readMaybe(path.join(dir, 'exit_code')); if (c2?.trim()) { exit = Number(c2); status = exit === 0 ? 'done' : status; } break; }
      await sleep(2000);
    }
  } finally { process.off('SIGTERM', onSig); process.off('SIGINT', onSig); }
  const last = (readMaybe(path.join(dir, 'last.txt')) || '').trim();
  const out = (readMaybe(path.join(dir, 'stdout.txt')) || '').split('\n').filter((l) => !/^\[dsh-[\w-]+\]/.test(l)).join('\n').trim();
  const answer = last || out;
  const ok = status === 'done';
  return { ok, exit_code: ok ? 0 : EXIT.failed, status: status === 'running' ? 'timeout' : status, answer, details: `agent: ${id} (${t.backend})\noutput: ${dir}`, agent_id: id, output_dir: dir, error: ok ? null : ((readMaybe(path.join(dir, 'stderr.txt')) || '').trim().slice(-800) || status) };
}

// ---------------------------------------------------------------- entry
export async function ask(opts) {
  const cfg = opts.cfg || loadConfig();
  const t = targetFrom({ backend: opts.backend, model: opts.model, effort: opts.effort, site: opts.site }, cfg);
  const api = opts.api || makeApi({ cfg, retrySec: 90 });
  const prompt = String(opts.prompt || '').trim();
  if (!prompt) throw Object.assign(new Error('empty prompt'), { usage: true });
  let r;
  if (t.kind === 'web') r = await askWeb({ prompt, t, opts, cfg, api });
  else if (t.kind === 'gateway') r = await askGateway({ prompt, t, opts, cfg });
  else r = await askAgent({ prompt, t, opts, cfg, api });
  return { target: targetLabel(t), kind: t.kind, ...r };
}

function readStdin() {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) return resolve('');
    let s = ''; process.stdin.setEncoding('utf8');
    process.stdin.on('data', (d) => { s += d; }); process.stdin.on('end', () => resolve(s)); process.stdin.on('error', () => resolve(s));
  });
}

// CLI: webhub ask [--backend SPEC] [--model M] [--effort E] [--session NAME] [--chat URL]
//      [--cwd DIR] [--account A] [--timeout SEC] [--json] [--result-file F] [-f FILE | words | stdin]
export async function askCli(words, flags) {
  let prompt = flags.file ? fs.readFileSync(flags.file === '-' ? 0 : flags.file, 'utf8') : words.join(' ');
  if (!prompt.trim()) prompt = await readStdin();
  let r;
  try {
    r = await ask({
      prompt, backend: flags.backend, site: flags.site, model: flags.model, effort: flags.effort, session: flags.session, chat: flags.chat,
      cwd: flags.cwd, account: flags.account, timeoutSec: flags.timeout || 1800, from: flags.from, title: flags.title, driver: flags.driver,
      allowPro: flags.allowPro, noOperator: flags.operator ? false : true, keepTab: flags.keepTab, system: flags.system,
    });
  } catch (e) {
    const code = e.usage ? EXIT.usage : e.unreachable ? EXIT.unreachable : EXIT.failed;
    r = { ok: false, exit_code: code, status: 'failed', answer: '', error: e.message };
  }
  if (flags.resultFile) { const t = `${flags.resultFile}.tmp-${process.pid}`; fs.writeFileSync(t, JSON.stringify(r, null, 2)); fs.renameSync(t, flags.resultFile); }
  if (flags.json) console.log(JSON.stringify(r, null, 2));
  else {
    if (r.answer) process.stdout.write(r.answer.endsWith('\n') ? r.answer : r.answer + '\n');
    if (r.details) process.stderr.write(`---\n${r.details}\n`);
    if (r.error && !r.ok) process.stderr.write(`ask: ${r.status}: ${r.error}\n`);
  }
  return r.exit_code ?? (r.ok ? 0 : EXIT.failed);
}
