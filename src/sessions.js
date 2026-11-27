// Named sessions: "keep asking in the same conversation" across separate `ask` calls and agents.
//   web      -> the chat URL of the current conversation (+ site/account), and how many MCP tool
//               calls that conversation has used. When the count reaches the site's budget the
//               next turn starts a NEW chat whose first message carries a handoff summary, so the
//               work goes on instead of hitting the per-conversation tool limit.
//   gateway  -> the message history (trimmed to the last history_turns turns).
// Files: STATE_DIR/sessions/<name>.json (0600). A session is used by one ask at a time (lock dir).
import fs from 'node:fs';
import path from 'node:path';
import { STATE_DIR } from './config.js';

const DIR = () => path.join(STATE_DIR, 'sessions');
const NAME_RE = /^[A-Za-z0-9][\w.-]{0,63}$/;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const SESSION_DEFAULTS = {
  // MCP tool calls one web conversation may use before the next turn moves to a fresh chat.
  // Measured (see docs/limits.md): Gemini Task-mode chats ran 100+ calls; older Chat-mode turns
  // stopped after ~8-9 calls per turn. The budget is per conversation, kept well below that.
  max_tool_calls: { gemini: 80, chatgpt: 80 },
  history_turns: 20,      // gateway sessions: turns of history sent with each prompt
  handoff_turns: 6,       // how many earlier turn summaries the handoff message carries
};

export function sessionCfg(cfg) {
  const s = cfg.sessions || {};
  return { ...SESSION_DEFAULTS, ...s, max_tool_calls: { ...SESSION_DEFAULTS.max_tool_calls, ...(s.max_tool_calls || {}) } };
}

export function checkName(name) {
  if (!NAME_RE.test(String(name || ''))) throw Object.assign(new Error(`bad session name "${name}" (letters, digits, . _ -; up to 64)`), { usage: true });
  return name;
}

const file = (name) => path.join(DIR(), `${checkName(name)}.json`);
export function loadSession(name) { try { return JSON.parse(fs.readFileSync(file(name), 'utf8')); } catch { return null; } }
export function saveSession(s) {
  fs.mkdirSync(DIR(), { recursive: true, mode: 0o700 });
  s.updated = new Date().toISOString();
  const p = file(s.name), t = `${p}.tmp-${process.pid}`;
  fs.writeFileSync(t, JSON.stringify(s, null, 2) + '\n', { mode: 0o600 }); fs.renameSync(t, p);
  return s;
}
export function listSessions() {
  try {
    return fs.readdirSync(DIR()).filter((f) => f.endsWith('.json')).map((f) => { try { return JSON.parse(fs.readFileSync(path.join(DIR(), f), 'utf8')); } catch { return null; } })
      .filter(Boolean).sort((a, b) => String(b.updated).localeCompare(String(a.updated)));
  } catch { return []; }
}
export function deleteSession(name) { try { fs.rmSync(file(name)); return true; } catch { return false; } }

export function newSession(name, target) {
  return { name: checkName(name), target: target.spec || null, kind: target.kind, site: target.site || null, account: null, chat_url: null, chat_tool_calls: 0, chats: [], turns: [], history: [], created: new Date().toISOString() };
}

// Serializes asks on one session (another process may hold it; a stale lock > 6 h is broken).
export async function withSessionLock(name, fn, { waitSec = 3600 } = {}) {
  fs.mkdirSync(DIR(), { recursive: true, mode: 0o700 });
  const lock = path.join(DIR(), `${checkName(name)}.lock`);
  const until = Date.now() + waitSec * 1000;
  for (;;) {
    try { fs.mkdirSync(lock); fs.writeFileSync(path.join(lock, 'pid'), String(process.pid)); break; } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      let stale = false;
      try {
        const pid = Number(fs.readFileSync(path.join(lock, 'pid'), 'utf8'));
        try { process.kill(pid, 0); } catch (err) { stale = err.code === 'ESRCH'; }
        if (Date.now() - fs.statSync(lock).mtimeMs > 6 * 3600e3) stale = true;
      } catch { stale = Date.now() - (fs.statSync(lock, { throwIfNoEntry: false })?.mtimeMs || 0) > 10000; }
      if (stale) { fs.rmSync(lock, { recursive: true, force: true }); continue; }
      if (Date.now() > until) throw new Error(`session "${name}" is busy (another ask holds it)`);
      await sleep(1000);
    }
  }
  try { return await fn(); } finally { fs.rmSync(lock, { recursive: true, force: true }); }
}

// Does the next web turn need a fresh chat?
export function needsRollover(s, cfg) {
  if (!s?.chat_url || s.kind !== 'web') return false;
  const cap = sessionCfg(cfg).max_tool_calls[s.site] ?? 80;
  return cap > 0 && (s.chat_tool_calls || 0) >= cap;
}

// First message of a fresh chat that continues earlier work.
export function handoffPrompt(s, prompt, cfg, { reason = 'the previous chat used up its tool-call budget' } = {}) {
  const n = sessionCfg(cfg).handoff_turns;
  const turns = (s.turns || []).slice(-n);
  const first = (s.turns || [])[0];
  const lines = [
    `HANDOFF — this continues work from an earlier conversation (${reason}). You cannot see that chat; this is what happened there.`,
    first ? `Original request:\n${String(first.prompt || '').slice(0, 1500)}` : '',
    turns.length ? `Progress so far (oldest first):\n${turns.map((t, i) => `${i + 1}. ${String(t.summary || '').slice(0, 700)}`).join('\n')}` : '',
    'Check the current state on disk before redoing anything, then continue.',
    '',
    `NEW MESSAGE:\n${prompt}`,
  ];
  return lines.filter((x) => x !== '').join('\n\n');
}

export function recordWebTurn(s, { prompt, task, rolledOver }) {
  const calls = task.tool_calls || 0;
  if (rolledOver && s.chat_url) {
    const cur = s.chats.find((c) => c.chat_url === s.chat_url);
    if (cur) { cur.ended = new Date().toISOString(); cur.reason = 'tool-call budget'; }
  }
  if (task.chat_url && task.chat_url !== s.chat_url) {
    s.chats.push({ chat_url: task.chat_url, tool_calls: 0, started: new Date().toISOString() });
    s.chat_url = task.chat_url; s.chat_tool_calls = 0;
  }
  s.chat_tool_calls = (s.chat_tool_calls || 0) + calls;
  const cur = s.chats.find((c) => c.chat_url === s.chat_url); if (cur) cur.tool_calls = s.chat_tool_calls;
  if (task.account) s.account = task.account;
  const f = task.final;
  s.turns.push({ at: new Date().toISOString(), task_id: task.id, prompt: String(prompt).slice(0, 1500), status: task.status, tool_calls: calls, chat_url: task.chat_url || null, summary: f ? String(f.summary || f.content || '').slice(0, 1200) : `(no final report: ${task.status}${task.error ? ` — ${task.error}` : ''})` });
  s.turns = s.turns.slice(-50);
  return s;
}

// CLI: webhub session list | show NAME | rm NAME
export async function sessionCli(args, flags) {
  const sub = args[0] || 'list';
  if (sub === 'list' || sub === 'ls') {
    const all = listSessions();
    if (flags.json) { console.log(JSON.stringify(all.map(({ history, ...s }) => ({ ...s, history_turns: (history || []).length / 2 })), null, 2)); return 0; }
    if (!all.length) { console.log('no sessions yet (webhub ask --session NAME ... creates one)'); return 0; }
    for (const s of all) console.log(`${s.name.padEnd(20)} ${String(s.kind).padEnd(8)} ${(s.site || s.target || '').padEnd(10)} turns ${String(s.turns.length).padStart(3)}  chats ${s.chats?.length || 0}  calls in current chat ${s.chat_tool_calls || 0}  ${s.chat_url || ''}`);
    return 0;
  }
  const name = args[1];
  if (!name) { console.error(`usage: webhub session ${sub} <name>`); return 2; }
  if (sub === 'show') { const s = loadSession(name); if (!s) { console.error(`no session ${name}`); return 2; } console.log(JSON.stringify(s, null, 2)); return 0; }
  if (sub === 'rm' || sub === 'delete' || sub === 'forget') { console.log(deleteSession(name) ? `forgot session ${name}` : `no session ${name}`); return 0; }
  console.error('usage: webhub session list | show <name> | rm <name>');
  return 2;
}
