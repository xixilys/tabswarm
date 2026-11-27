#!/usr/bin/env node
// End-to-end check of every MCP tool over Streamable HTTP, including the
// security rules (out-of-root paths, protected files, dangerous commands, conflicts).
//   node scripts/smoke.mjs                       (self-contained: temp state + own server)
//   node scripts/smoke.mjs --url http://127.0.0.1:8781/mcp --root /path/to/scratch/dir   (live hub)
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
// Without --url/--root the smoke test is self-contained: its own temp state dir, scratch root and
// server on 18787/18788 (so `npm test` never touches the live hub). With --url/--root it checks a
// running hub instead (state from GWM_STATE_DIR or ~/.gemini-web-mcp).
const SELF = !opt('--url') && !opt('--root');
let server = null, serverLog = '';
if (SELF) {
  const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gwm-smoke-')));
  const st = path.join(TMP, 'state'), root = path.join(TMP, 'root');
  for (const d of [st, root]) fs.mkdirSync(d, { recursive: true });
  process.env.GWM_STATE_DIR = st; process.env.WEBHUB_STATE_DIR = st;
  fs.writeFileSync(path.join(st, 'config.json'), JSON.stringify({ public_port: 18787, admin_port: 18788, roots: [{ name: 'smoke', path: root }] }));
  argv.push('--root', root);
  const { spawn } = await import('node:child_process');
  server = spawn(process.execPath, [path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'src', 'server.js')], { env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
  server.stdout.on('data', (d) => { serverLog += d; }); server.stderr.on('data', (d) => { serverLog += d; });
  process.on('exit', () => { try { server.kill(); } catch { /* ignore */ } fs.rmSync(TMP, { recursive: true, force: true }); });
  let up = false;
  for (let i = 0; i < 50 && !up; i++) { up = await fetch('http://127.0.0.1:18788/api/state').then((r) => r.ok).catch(() => false); if (!up) await new Promise((r) => setTimeout(r, 200)); }
  if (!up) { console.error('smoke: isolated server did not start\n' + serverLog); process.exit(1); }
}
const STATE = process.env.GWM_STATE_DIR || path.join(os.homedir(), '.gemini-web-mcp');
const cfg = JSON.parse(fs.readFileSync(path.join(STATE, 'config.json'), 'utf8'));
const secrets = JSON.parse(fs.readFileSync(path.join(STATE, 'secrets.json'), 'utf8'));
const URL_ = opt('--url', `http://127.0.0.1:${cfg.public_port || 8781}/mcp`);
const BASE = opt('--root');
if (!BASE) { console.error('--root <scratch dir inside an allowed root> is required with --url'); process.exit(2); }
const ROOT = path.join(BASE, 'run-' + Date.now().toString(36)); // fresh subfolder every run
const TASK_A = opt('--task', 'smoke_' + Date.now().toString(36));
const TASK_B = TASK_A + '_b';

let pass = 0, fail = 0;
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${name}`); } else { fail++; console.log(`  \x1b[31m✗ ${name}\x1b[0m ${detail}`); }
}
const txt = (r) => (r.content || []).map((c) => c.text).join('\n');

async function connect(token) {
  const client = new Client({ name: 'gwm-smoke', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(URL_), { requestInit: { headers: { Authorization: `Bearer ${token}` } } });
  await client.connect(transport);
  return client;
}

// 0. unauthenticated request is refused with an OAuth challenge
{
  const r = await fetch(URL_, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}' });
  check('no token -> 401 with resource_metadata', r.status === 401 && /resource_metadata=/.test(r.headers.get('www-authenticate') || ''), `status ${r.status}`);
  const bad = await fetch(URL_, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer nope' }, body: '{}' });
  check('wrong token -> 401', bad.status === 401);
}

const c = await connect(secrets.static_bearer);
const call = (name, args) => c.callTool({ name, arguments: args });
const tools = (await c.listTools()).tools.map((t) => t.name).sort();
console.log('tools:', tools.join(', '));
check('all tools listed', ['command_output', 'edit_file', 'git_diff', 'git_log', 'git_status', 'list_dir', 'list_roots', 'read_file', 'report', 'run_command', 'search', 'write_file'].every((t) => tools.includes(t)));

fs.mkdirSync(ROOT, { recursive: true });
const f = path.join(ROOT, 'hello.py');

let r = await call('list_roots', { task_id: TASK_A });
check('list_roots', !r.isError && txt(r).includes('"path"'));
r = await call('write_file', { task_id: TASK_A, path: f, content: 'def add(a, b):\n    return a + b\n\nprint(add(2, 3))\n' });
check('write_file creates + diff', !r.isError && txt(r).includes('+def add'), txt(r));
r = await call('read_file', { task_id: TASK_A, path: f });
check('read_file', !r.isError && txt(r).includes('return a + b'));
r = await call('edit_file', { task_id: TASK_A, path: f, edits: [{ old_text: 'return a + b', new_text: 'return a + b  # sum' }] });
check('edit_file diff', !r.isError && txt(r).includes('+    return a + b  # sum'), txt(r));
r = await call('list_dir', { task_id: TASK_A, path: ROOT });
check('list_dir', !r.isError && txt(r).includes('hello.py'));
r = await call('search', { task_id: TASK_A, path: ROOT, query: 'def add' });
check('search content', !r.isError && txt(r).includes('hello.py'), txt(r));
r = await call('search', { task_id: TASK_A, path: ROOT, query: '*.py', mode: 'filename' });
check('search filename', !r.isError && txt(r).includes('hello.py'), txt(r));
r = await call('run_command', { task_id: TASK_A, cwd: ROOT, command: 'python3 hello.py && echo done' });
check('run_command', !r.isError && txt(r).includes('5') && txt(r).includes('exit 0'), txt(r));
r = await call('run_command', { task_id: TASK_A, cwd: ROOT, command: 'for i in 1 2 3; do echo tick $i; sleep 1; done', wait_seconds: 1 });
const job = /job_id="(job_[a-f0-9]+)"/.exec(txt(r))?.[1];
check('long command returns job_id', !!job, txt(r));
if (job) { r = await call('command_output', { task_id: TASK_A, job_id: job, wait_seconds: 10 }); check('command_output finishes', txt(r).includes('tick 3') && txt(r).includes('exit 0'), txt(r)); }
r = await call('run_command', { task_id: TASK_A, cwd: ROOT, command: 'sleep 5', timeout_seconds: 1 });
check('command timeout kills', txt(r).includes('timed out'), txt(r));

// git
await call('run_command', { task_id: TASK_A, cwd: ROOT, command: 'git init -q . 2>/dev/null; git add -A && git -c user.email=t@t -c user.name=t commit -qm init && echo "x = 1" >> hello.py' });
r = await call('git_status', { task_id: TASK_A, repo: ROOT });
check('git_status', !r.isError && txt(r).includes('hello.py'), txt(r));
r = await call('git_diff', { task_id: TASK_A, repo: ROOT });
check('git_diff', !r.isError && txt(r).includes('+x = 1'), txt(r));
r = await call('git_log', { task_id: TASK_A, repo: ROOT });
check('git_log', !r.isError && txt(r).includes('init'), txt(r));

// security
console.log('security:');
r = await call('read_file', { task_id: TASK_A, path: '/etc/passwd' });
check('read outside roots denied', r.isError && txt(r).includes('outside allowed roots'), txt(r));
r = await call('read_file', { task_id: TASK_A, path: path.join(ROOT, '../../../../../../etc/hosts') });
check('.. traversal denied', r.isError, txt(r));
fs.rmSync(path.join(ROOT, 'escape'), { force: true }); fs.symlinkSync('/etc', path.join(ROOT, 'escape'));
r = await call('read_file', { task_id: TASK_A, path: path.join(ROOT, 'escape/hosts') });
check('symlink escape denied', r.isError && txt(r).includes('outside'), txt(r));
fs.rmSync(path.join(ROOT, 'escape'));
r = await call('write_file', { task_id: TASK_A, path: path.join(os.homedir(), 'gwm-should-not-exist.txt'), content: 'x' });
check('write outside roots denied', r.isError && !fs.existsSync(path.join(os.homedir(), 'gwm-should-not-exist.txt')), txt(r));
r = await call('write_file', { task_id: TASK_A, path: path.join(ROOT, '.env'), content: 'SECRET=1' });
check('protected file (.env) denied', r.isError && txt(r).includes('protected'), txt(r));
r = await call('run_command', { task_id: TASK_A, cwd: '/tmp', command: 'ls' });
check('cwd outside roots denied', r.isError, txt(r));
r = await call('run_command', { task_id: TASK_A, cwd: ROOT, command: 'sudo ls' });
check('sudo denied', r.isError && txt(r).includes('DENIED'), txt(r));
r = await call('run_command', { task_id: TASK_A, cwd: ROOT, command: 'rm -rf ~' });
check('rm -rf ~ denied', r.isError && txt(r).includes('DENIED'), txt(r));
// dangerous_policy "auto" (default): risky commands run without approval after a safety snapshot
await call('run_command', { task_id: TASK_A, cwd: ROOT, command: 'mkdir -p build && echo x > build/f.o' });
r = await call('run_command', { task_id: TASK_A, cwd: ROOT, command: 'rm -rf build' });
check('rm -rf build auto-allowed with a safety copy, build gone', !r.isError && /\[safety: .*(copied|git snapshot)/.test(txt(r)) && !fs.existsSync(path.join(ROOT, 'build')), txt(r));
r = await call('run_command', { task_id: TASK_A, cwd: ROOT, command: 'git config --global --get core.editor; echo ran' });
check('risky git command auto-allowed and logged', !r.isError && /ran/.test(txt(r)) && /\[safety:/.test(txt(r)), txt(r));
r = await call('run_command', { task_id: TASK_A, cwd: ROOT, command: `echo pwned > ${os.homedir()}/gwm-sandbox-test.txt; cat ~/.ssh/config | head -1; echo after` });
check('sandbox blocks writes outside roots', !fs.existsSync(path.join(os.homedir(), 'gwm-sandbox-test.txt')), txt(r));
check('sandbox blocks reading ~/.ssh', /Operation not permitted|No such file/.test(txt(r)), txt(r));

// conflicts between tasks
console.log('conflicts:');
r = await call('edit_file', { task_id: TASK_B, path: f, edits: [{ old_text: 'x = 1', new_text: 'x = 2' }] });
check('second task editing a file owned by an active task -> CONFLICT', r.isError && txt(r).includes('CONFLICT'), txt(r));
fs.appendFileSync(f, '# external change\n');
r = await call('edit_file', { task_id: TASK_A, path: f, edits: [{ old_text: 'x = 1', new_text: 'x = 3' }] });
check('file changed since read -> CONFLICT', r.isError && txt(r).includes('changed on disk'), txt(r));

r = await call('report', { task_id: TASK_A, status: 'final', summary: 'smoke test finished', content: `pass=${pass} fail=${fail}`, files_changed: [f], tests: 'scripts/smoke.mjs' });
check('report', !r.isError);
await c.close();
console.log(`\n${fail ? '\x1b[31m' : '\x1b[32m'}${pass} passed, ${fail} failed\x1b[0m (task ${TASK_A})`);
process.exit(fail ? 1 : 0);
