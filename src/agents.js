// Local agents started by the web model (MCP tools agent_spawn / agent_status / agent_result /
// agent_list), by `webhub ask --backend <agent>` and by swarms. Backends are argv templates from
// config (agents.backends + agents.commands). Built in:
//   claude      — Claude Code `-p`, sandboxed Bash, edits in cwd only
//   codex       — `codex exec -s workspace-write` in cwd
//   web-chatgpt — another ChatGPT web chat through this hub (`webhub ask --backend web:chatgpt`)
//   web-gemini  — another Gemini web chat through this hub
//   gateway     — one turn on the configured HTTP model gateway (`webhub ask --backend gateway`)
// Add your own in config.json, e.g. "agy": ["agy", "--model", "{model?}", "-p", "{prompt}"].
// Template variables: {prompt} {cwd} {dir} (the agent's output dir) {last} (file for the final
// message) {model} {effort} {account} {chat}. A "{x?}" element is optional: when x is empty the
// element is dropped together with the flag right before it ("--model", "{model?}" -> nothing).
// Guards: cwd must be inside an allowed root; agents.max_running at once; agents.timeout_min per
// agent (killed after); agents.daily_limit starts per local day; backends in agents.approval_backends
// wait for the owner's approval (same queue as dangerous commands).
// Each agent is detached with its output going straight to files, so it survives a server restart:
//   <cwd>/.gemweb/agents/<id>/{prompt.txt, stdout.txt, stderr.txt, last.txt, exit_code}   (readable with read_file)
// and its record lives in STATE_DIR/agents/<id>.json. agent_result returns a summary + these paths.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { STATE_DIR, expandHome, newId } from './config.js';
import { localDay } from './quota.js';

const CLAUDE_SETTINGS = JSON.stringify({ sandbox: { enabled: true, autoAllowBashIfSandboxed: true } });

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'webhub.mjs');
const WEB_ARGS = ['--model', '{model?}', '--effort', '{effort?}', '--account', '{account?}', '--chat', '{chat?}'];

export const AGENT_DEFAULTS = {
  backends: ['claude', 'codex', 'web-chatgpt', 'web-gemini', 'gateway'], // allowed backends (others must be added explicitly)
  default_backend: 'claude',
  approval_backends: [], // backends that wait for the owner's approval before starting
  max_running: 10,
  timeout_min: 30,
  max_timeout_min: 120,
  daily_limit: 100,
  result_chars: 3000,      // how much of the agent's final message agent_result returns
  // appended to every local (non-web) agent prompt
  prompt_suffix: 'Track your file changes with git and commit when you are done.',
  commands: {
    claude: ['claude', '-p', '--model', '{model?}', '--permission-mode', 'acceptEdits', '--settings', CLAUDE_SETTINGS, '--output-format', 'text', '{prompt}'],
    codex: ['codex', 'exec', '--skip-git-repo-check', '-s', 'workspace-write', '-m', '{model?}', '-C', '{cwd}', '-o', '{last}', '{prompt}'],
    'web-chatgpt': [process.execPath, CLI, 'ask', '--backend', 'web:chatgpt', ...WEB_ARGS, '--cwd', '{cwd}', '-f', '{dir}/prompt.txt'],
    'web-gemini': [process.execPath, CLI, 'ask', '--backend', 'web:gemini', ...WEB_ARGS, '--cwd', '{cwd}', '-f', '{dir}/prompt.txt'],
    gateway: [process.execPath, CLI, 'ask', '--backend', 'gateway', '--model', '{model?}', '--effort', '{effort?}', '--cwd', '{cwd}', '-f', '{dir}/prompt.txt'],
  },
};

export function agentCfg(cfg) {
  const a = cfg.agents || {};
  return { ...AGENT_DEFAULTS, ...a, commands: { ...AGENT_DEFAULTS.commands, ...(a.commands || {}) } };
}

function pidAlive(pid) { if (!pid) return false; try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } }
const readMaybe = (p) => { try { return fs.readFileSync(p, 'utf8'); } catch { return null; } };
function tail(s, n) { s = String(s || ''); return s.length > n ? `…[${s.length - n} earlier chars in the file]\n` + s.slice(-n) : s; }
function head(s, n) { s = String(s || ''); return s.length > n ? s.slice(0, n) + `\n…[+${s.length - n} chars in the file]` : s; }

export function fillArgv(tpl, vars) {
  const out = [];
  for (const x of tpl) {
    // {name?} drops itself and the flag before it when empty; {name?fallback} uses the fallback
    const opt = /^\{(\w+)\?([^{}]*)\}$/.exec(String(x));
    if (opt) {
      const v = vars[opt[1]] || opt[2];
      if (v === undefined || v === null || v === '') { if (out.length && /^-/.test(out[out.length - 1])) out.pop(); continue; }
      out.push(String(v)); continue;
    }
    out.push(expandHome(String(x)).replace(/\{(prompt|cwd|dir|overlay|last|model|effort|account|chat)\}/g, (_, k) => vars[k] ?? ''));
  }
  return out;
}

export class AgentManager {
  constructor(cfg, paths, events, approvals) {
    this.cfg = cfg; this.paths = paths; this.events = events; this.approvals = approvals;
    this.dir = path.join(STATE_DIR, 'agents');
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    this.agents = new Map();
    for (const f of fs.readdirSync(this.dir)) {
      if (!f.endsWith('.json')) continue;
      try { const a = JSON.parse(fs.readFileSync(path.join(this.dir, f), 'utf8')); this.agents.set(a.id, a); } catch { /* skip */ }
    }
    this.timer = setInterval(() => this.poll(), 2000); this.timer.unref();
    this.poll();
  }

  get c() { return agentCfg(this.cfg); }
  save(a) { fs.writeFileSync(path.join(this.dir, `${a.id}.json`), JSON.stringify(a, null, 2)); }
  running() { return [...this.agents.values()].filter((a) => a.status === 'running'); }
  startedToday() { const d = localDay(); return [...this.agents.values()].filter((a) => a.started && localDay(new Date(a.started)) === d).length; }

  // Returns { agent } or { error, denied }.
  async spawn({ backend, prompt, cwd, timeout_min, task_id, call_id, model, effort, account, chat_url }) {
    const c = this.c;
    backend = backend || c.default_backend;
    if (!c.backends.includes(backend)) return { error: `backend "${backend}" is not allowed here (allowed: ${c.backends.join(', ')}; set agents.backends in config.json)`, denied: true };
    if (!c.commands[backend]) return { error: `no command configured for backend "${backend}"`, denied: true };
    if (!String(prompt || '').trim()) return { error: 'prompt is empty' };
    const { abs } = this.paths.resolve(cwd); // throws PathError outside the roots
    if (!fs.statSync(abs).isDirectory()) return { error: `cwd is not a directory: ${abs}` };
    if (this.running().length >= c.max_running) return { error: `${this.running().length} agents are already running (agents.max_running = ${c.max_running}); wait for one to finish (agent_list)`, denied: true };
    if (c.daily_limit > 0 && this.startedToday() >= c.daily_limit) return { error: `${this.startedToday()} agents already started today (agents.daily_limit = ${c.daily_limit})`, denied: true };
    const timeoutMin = Math.max(0.01, Math.min(Number(timeout_min) || c.timeout_min, c.max_timeout_min));
    if (c.approval_backends.includes(backend) && this.cfg.dangerous_policy === 'auto') {
      this.events.emit('confirm.auto', { task_id, call_id, command: `agent_spawn ${backend}`, cwd: abs, reasons: [`starts a local ${backend} agent`], text: `auto-allowed: start a ${backend} agent in ${abs}` });
    } else if (c.approval_backends.includes(backend)) {
      if (this.cfg.dangerous_policy !== 'confirm') return { error: `backend "${backend}" needs the owner's approval and this server refuses such requests (dangerous_policy = ${this.cfg.dangerous_policy})`, denied: true };
      const v = await this.approvals.request({ task_id, call_id, command: `agent_spawn ${backend}: ${String(prompt).slice(0, 300)}`, cwd: abs, reasons: [`starts a local ${backend} agent that can edit files and run commands in ${abs}`] });
      if (!v.approved) return { error: v.how === 'timeout' ? `needs the owner's approval on the local status page (starts a ${backend} agent); not approved within ${this.cfg.confirm_wait_sec}s. Ask the user to approve, then retry the identical call.` : `owner denied starting a ${backend} agent`, denied: true };
    }
    const id = newId('ag', 4);
    const out = path.join(abs, '.gemweb', 'agents', id);
    fs.mkdirSync(out, { recursive: true });
    const gi = path.join(abs, '.gemweb', 'agents', '.gitignore'); if (!fs.existsSync(gi)) fs.writeFileSync(gi, '*\n');
    if (backend === 'web-chatgpt' || backend === 'web-gemini' || c.web_backends?.includes(backend)) {
      prompt = `${prompt}\n\nYou are a leaf worker: do NOT call agent_spawn recursively; edit only your assigned files, verify them locally, and finish with report(status="final").`.trim();
    } else {
      prompt = `${prompt}\n\n${c.prompt_suffix}`.trim();
    }
    fs.writeFileSync(path.join(out, 'prompt.txt'), prompt);
    let overlay = '';
    if (backend === 'dsh' && c.dsh_model && c.dsh_provider) {
      overlay = path.join(this.dir, `dsh-${c.dsh_model.replace(/[^\w.-]/g, '_')}.yml`);
      // the configured model and provider; no browser MCP (a headless profile could otherwise attach to an everyday Chrome)
      fs.writeFileSync(overlay, `- id: agent-default-model\n  config:\n    provider: ${c.dsh_provider}\n    model: ${c.dsh_model}\n    reasoningEffort: ${c.dsh_effort || 'low'}\n- id: mcp-browser\n  disabled: true\n`);
    }
    const files = { stdout: path.join(out, 'stdout.txt'), stderr: path.join(out, 'stderr.txt'), last: path.join(out, 'last.txt'), exit: path.join(out, 'exit_code') };
    const argv = fillArgv(c.commands[backend], { prompt, cwd: abs, dir: out, overlay, last: files.last, model: model || '', effort: effort || '', account: account || '', chat: chat_url || '' });
    const o = fs.openSync(files.stdout, 'a'), e = fs.openSync(files.stderr, 'a');
    // sh records the exit code in a file, so the result survives a server restart.
    const ch = spawn('/bin/sh', ['-c', 'cd "$1" || exit 97; shift; "$@"; echo $? > "$GWM_AGENT_EXIT"', 'gwm-agent', abs, ...argv], {
      detached: true, stdio: ['ignore', o, e],
      env: {
        PATH: `${path.dirname(process.execPath)}:${this.cfg.command_path}:${os.homedir()}/.local/bin`, HOME: os.homedir(), USER: os.userInfo().username, LANG: process.env.LANG || 'en_US.UTF-8', TERM: 'dumb', GWM_AGENT_EXIT: files.exit, GWM_AGENT_ID: id, NO_COLOR: '1',
        // web-chatgpt / web-gemini run `webhub`, which must talk to THIS hub instance, not the default one
        ...(process.env.WEBHUB_STATE_DIR ? { WEBHUB_STATE_DIR: process.env.WEBHUB_STATE_DIR } : {}),
        ...(process.env.GWM_STATE_DIR ? { GWM_STATE_DIR: process.env.GWM_STATE_DIR } : {}),
        // the gateway backend (and nested asks) need the gateway settings and its key variable
        ...Object.fromEntries(Object.entries(process.env).filter(([k]) => k.startsWith('TABSWARM_') || Object.values(this.cfg.gateways || {}).some((g) => g?.api_key_env === k))),
      },
    });
    ch.on('error', () => {});
    ch.unref(); fs.closeSync(o); fs.closeSync(e);
    const a = {
      id, backend, model: model || null, task_id: task_id || null, cwd: abs, prompt_preview: String(prompt).slice(0, 300), dir: out, files, pid: ch.pid,
      status: 'running', started: new Date().toISOString(), deadline: new Date(Date.now() + timeoutMin * 60000).toISOString(), timeout_min: timeoutMin,
      ended: null, exit_code: null,
    };
    this.agents.set(id, a); this.save(a);
    this.events.emit('agent.start', { task_id: task_id || undefined, call_id, agent_id: id, backend, cwd: abs, pid: ch.pid, timeout_min: timeoutMin, text: `${backend} agent ${id} started in ${abs}: ${a.prompt_preview.slice(0, 120)}` });
    return { agent: a };
  }

  poll() {
    for (const a of this.running()) {
      const code = readMaybe(a.files.exit);
      if (code !== null && code.trim() !== '') { this.finish(a, a.timed_out ? 'timeout' : (Number(code) === 0 ? 'done' : 'failed'), Number(code)); continue; }
      if (Date.now() > Date.parse(a.deadline) && !a.timed_out) { a.timed_out = true; this.save(a); this.kill(a); continue; }
      if (!pidAlive(a.pid)) this.finish(a, a.timed_out ? 'timeout' : a.killed ? 'killed' : 'lost', null);
    }
  }

  kill(a) {
    try { process.kill(-a.pid, 'SIGTERM'); } catch { /* gone */ }
    setTimeout(() => { try { process.kill(-a.pid, 'SIGKILL'); } catch { /* gone */ } }, 5000).unref();
  }

  stop(id) {
    const a = this.agents.get(id);
    if (!a || a.status !== 'running') return false;
    a.killed = true; this.save(a); this.kill(a); return true;
  }

  finish(a, status, code) {
    a.status = status; a.exit_code = code; a.ended = new Date().toISOString();
    a.duration_sec = Math.round((Date.parse(a.ended) - Date.parse(a.started)) / 1000);
    this.save(a);
    const s = this.summary(a);
    this.events.emit('agent.end', { task_id: a.task_id || undefined, agent_id: a.id, backend: a.backend, status, exit_code: code, duration_sec: a.duration_sec, result_preview: s.result.slice(0, 1500), text: `${a.backend} agent ${a.id} ${status}${code !== null ? ` (exit ${code})` : ''} after ${a.duration_sec}s` });
  }

  // The agent's final message: its last-message file (codex), else stdout.
  resultText(a) {
    const last = readMaybe(a.files.last);
    if (last && last.trim()) return last.trim();
    // dsh plugins print status lines ("[dsh-cost-meter] …") on stdout around the answer
    return (readMaybe(a.files.stdout) || '').split('\n').filter((l) => !/^\[dsh-[\w-]+\]/.test(l)).join('\n').trim();
  }

  summary(a) {
    const c = this.c;
    const text = this.resultText(a);
    const err = (readMaybe(a.files.stderr) || '').trim();
    return {
      id: a.id, backend: a.backend, status: a.status, exit_code: a.exit_code, cwd: a.cwd, started: a.started, ended: a.ended,
      elapsed_sec: Math.round(((a.ended ? Date.parse(a.ended) : Date.now()) - Date.parse(a.started)) / 1000),
      result: a.status === 'running' ? '' : head(text, c.result_chars),
      stderr_tail: a.status === 'running' || a.status === 'done' ? '' : tail(err, 800),
      files: { output_dir: a.dir, stdout: a.files.stdout, stderr: a.files.stderr, ...(fs.existsSync(a.files.last) ? { last_message: a.files.last } : {}), prompt: path.join(a.dir, 'prompt.txt') },
    };
  }

  status(a) {
    const out = readMaybe(a.files.stdout) || '';
    return { ...this.summary(a), result: undefined, stdout_bytes: out.length, stdout_tail: a.status === 'running' ? tail(out, 600) : undefined, deadline: a.deadline };
  }

  get(id) { return this.agents.get(String(id || '').trim()); }
  list(n = 30) {
    return [...this.agents.values()].sort((x, y) => y.started.localeCompare(x.started)).slice(0, n)
      .map((a) => ({ id: a.id, backend: a.backend, status: a.status, task_id: a.task_id, cwd: a.cwd, started: a.started, ended: a.ended, prompt: a.prompt_preview.slice(0, 120) }));
  }
  limits() { const c = this.c; return { running: this.running().length, max_running: c.max_running, started_today: this.startedToday(), daily_limit: c.daily_limit, backends: c.backends, default_backend: c.default_backend, approval_backends: c.approval_backends }; }
}
