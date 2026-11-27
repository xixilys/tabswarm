#!/usr/bin/env node
// Tests for the local-agent tools (agent_spawn / agent_status / agent_result / agent_list) with a
// fake agent CLI (scripts/fixtures/fake-agent.sh): no model is called. Runs its own server (temp
// state dir, ports 18781/18782).   node scripts/agent-test.mjs [--keep]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { reap } from './fixtures/reap.mjs';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(HERE, '..');
const FAKE = path.join(HERE, 'fixtures', 'fake-agent.sh');
const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gwm-atest-')));
const ROOT = path.join(TMP, 'root'); fs.mkdirSync(ROOT);
const STATE = path.join(TMP, 'state'); fs.mkdirSync(STATE);
const PUB = 18781, ADM = 18782;
fs.writeFileSync(path.join(STATE, 'config.json'), JSON.stringify({
  public_port: PUB, admin_port: ADM, roots: [{ name: 'atest', path: ROOT }], confirm_wait_sec: 6, dangerous_policy: 'confirm', // exercises the approval path (default is auto)
  agents: {
    backends: ['dsh', 'claude', 'codex', 'orca'], default_backend: 'dsh', approval_backends: ['orca'], prompt_suffix: 'Track your file changes with git and commit when you are done; push to the remote when useful.', max_running: 2, daily_limit: 9, timeout_min: 0.05, result_chars: 500,
    commands: { dsh: [FAKE, 'dsh', '{prompt}'], claude: [FAKE, 'claude', '{prompt}'], codex: [FAKE, 'codex', '-o', '{last}', '{prompt}'], orca: [FAKE, 'orca', '{prompt}'], extra: [FAKE, 'extra', '{prompt}'] },
  },
}));

let pass = 0, fail = 0;
const check = (name, ok, detail = '') => { if (ok) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${name}`); } else { fail++; console.log(`  \x1b[31m✗ ${name}\x1b[0m ${String(detail).slice(0, 700)}`); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let server, serverLog = '';
async function startServer() {
  server = reap(spawn(process.execPath, [path.join(REPO, 'src', 'server.js')], { env: { ...process.env, GWM_STATE_DIR: STATE }, stdio: ['ignore', 'pipe', 'pipe'] }));
  server.stdout.on('data', (d) => { serverLog += d; }); server.stderr.on('data', (d) => { serverLog += d; });
  for (let i = 0; i < 50; i++) { if (await fetch(`http://127.0.0.1:${ADM}/api/state`).then((r) => r.ok).catch(() => false)) return; await sleep(200); }
  throw new Error('server did not start\n' + serverLog);
}
async function stopServer() { server.kill('SIGTERM'); await new Promise((r) => server.on('close', r)); }
await startServer();
const secrets = JSON.parse(fs.readFileSync(path.join(STATE, 'secrets.json'), 'utf8'));
const admin = (p, o = {}) => fetch(`http://127.0.0.1:${ADM}/api${p}`, { method: o.method || 'GET', headers: { 'content-type': 'application/json', authorization: `Bearer ${secrets.admin_token}` }, body: o.body ? JSON.stringify(o.body) : undefined }).then((r) => r.json());

async function mcp() {
  const c = new Client({ name: 'agent-test', version: '1' });
  await c.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${PUB}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${secrets.static_bearer}` } } }));
  return c;
}
let client = await mcp();
const call = async (name, args) => { const r = await client.callTool({ name, arguments: { task_id: 'atest', ...args } }); const t = r.content.map((x) => x.text).join('\n'); let j = null; try { j = JSON.parse(t); } catch { /* text */ } return { err: !!r.isError, text: t, j }; };
async function waitDone(id, sec = 20) {
  for (let i = 0; i < sec * 4; i++) { const s = await call('agent_status', { agent_id: id }); if (s.j && s.j.status !== 'running') return s.j; await sleep(250); }
  return (await call('agent_status', { agent_id: id })).j;
}

console.log('tools:');
const names = (await client.listTools()).tools.map((t) => t.name);
check('agent_spawn / agent_status / agent_result / agent_list are offered', ['agent_spawn', 'agent_status', 'agent_result', 'agent_list'].every((n) => names.includes(n)), names.join(','));

console.log('dsh (default backend):');
let r = await call('agent_spawn', { prompt: 'Write the file. LONG', cwd: ROOT });
check('spawn returns an agent id at once', !r.err && /^ag_/.test(r.j?.agent_id) && r.j.backend === 'dsh', r.text);
const id1 = r.j?.agent_id;
let s = await waitDone(id1);
check('finishes: status done, exit 0', s?.status === 'done' && s.exit_code === 0, JSON.stringify(s));
check('the agent worked in cwd', fs.readFileSync(path.join(ROOT, 'agent-dsh.txt'), 'utf8').includes('done by dsh'));
check('agent inherits this hub\'s state dir (web-* agents must talk to the same instance)', fs.readFileSync(path.join(ROOT, 'agent-dsh.env'), 'utf8').trim() === `state_dir=${STATE}`, fs.readFileSync(path.join(ROOT, 'agent-dsh.env'), 'utf8'));
r = await call('agent_result', { agent_id: id1 });
check('result is a shortened summary, not the whole output', r.j && r.j.result.length < 700 && /chars in the file/.test(r.j.result), r.text.slice(0, 300));
check('full output on disk inside the root (readable with read_file)', r.j && fs.readFileSync(r.j.files.stdout, 'utf8').includes('FINAL: dsh finished') && r.j.files.stdout.startsWith(ROOT));
const rf = await call('read_file', { path: r.j.files.stdout, offset: 400, limit: 5 });
check('read_file can read it', !rf.err && /FINAL: dsh finished/.test(rf.text), rf.text.slice(0, 200));
check('agents.prompt_suffix is appended to the agent prompt', /commit when you are done; push to the remote when useful\.$/.test(fs.readFileSync(path.join(ROOT, '.gemweb', 'agents', id1, 'prompt.txt'), 'utf8').trim()));
check('output dir is git-ignored', fs.readFileSync(path.join(ROOT, '.gemweb', 'agents', '.gitignore'), 'utf8').trim() === '*');

console.log('codex / claude start without approval (owner\'s choice):');
let t0 = Date.now();
r = await call('agent_spawn', { backend: 'codex', prompt: 'Do it', cwd: ROOT });
check('codex starts at once, no approval asked', !r.err && r.j?.backend === 'codex' && Date.now() - t0 < 3000 && !(await admin('/events?limit=5000')).some((e) => e.type === 'confirm.pending'), r.text);
s = await waitDone(r.j?.agent_id);
r = await call('agent_result', { agent_id: r.j?.agent_id });
check('result = the agent\'s last message', r.j?.result === 'LAST MESSAGE from codex' && !!r.j.files.last_message, r.text.slice(0, 300));

t0 = Date.now();
r = await call('agent_spawn', { backend: 'claude', prompt: 'Do it', cwd: ROOT });
check('claude starts at once, no approval asked', !r.err && r.j?.backend === 'claude' && Date.now() - t0 < 3000, r.text);
await waitDone(r.j?.agent_id);

console.log('approval still works for backends in agents.approval_backends (orca):');
const pend2 = (async () => { for (let i = 0; i < 40; i++) { const st = await admin('/state'); const p = st.pending.find((x) => /agent_spawn orca/.test(x.command)); if (p) return admin(`/confirm/${p.id}`, { method: 'POST', body: { approve: false } }); await sleep(250); } return null; })();
r = await call('agent_spawn', { backend: 'orca', prompt: 'Do it', cwd: ROOT });
await pend2;
check('owner denies -> DENIED, nothing started', r.err && /DENIED: owner denied/.test(r.text) && !fs.existsSync(path.join(ROOT, 'agent-orca.txt')), r.text);

console.log('guards:');
r = await call('agent_spawn', { prompt: 'x', cwd: '/etc' });
check('cwd outside the roots -> DENIED', r.err && /DENIED/.test(r.text) && /outside/.test(r.text), r.text);
r = await call('agent_spawn', { backend: 'extra', prompt: 'x', cwd: ROOT });
check('backend not in agents.backends -> DENIED', r.err && /not allowed/.test(r.text), r.text);
r = await call('agent_spawn', { backend: 'bash', prompt: 'x', cwd: ROOT });
check('unknown backend -> DENIED', r.err && /not allowed/.test(r.text), r.text);

console.log('running limit, stop, timeout:');
const h1 = (await call('agent_spawn', { prompt: 'HANG', cwd: ROOT, timeout_minutes: 60 })).j?.agent_id;
const h2 = (await call('agent_spawn', { prompt: 'HANG' , cwd: ROOT })).j?.agent_id; // default timeout 0.05 min = 3 s
r = await call('agent_spawn', { prompt: 'third', cwd: ROOT });
check('third while 2 run (max_running 2) -> DENIED', r.err && /already running/.test(r.text), r.text);
r = await call('agent_status', { agent_id: h1, stop: true });
s = await waitDone(h1, 15);
check('agent_status stop=true kills it', s?.status === 'killed' || s?.status === 'failed', JSON.stringify(s));
s = await waitDone(h2, 20);
check('agent past its timeout is stopped: status timeout', s?.status === 'timeout', JSON.stringify(s));

console.log('failure:');
r = await call('agent_spawn', { prompt: 'FAIL', cwd: ROOT });
s = await waitDone(r.j?.agent_id);
r = await call('agent_result', { agent_id: r.j?.agent_id });
check('non-zero exit -> failed, stderr tail in the result', s?.status === 'failed' && s.exit_code === 3 && /something broke/.test(r.j?.stderr_tail || ''), r.text.slice(0, 400));

console.log('survives a server restart:');
r = await call('agent_spawn', { prompt: 'SLEEP 3', cwd: ROOT, timeout_minutes: 5 });
const idr = r.j?.agent_id;
await client.close(); await stopServer(); await sleep(500); await startServer(); client = await mcp();
s = await waitDone(idr, 20);
check('agent started before the restart finishes and reports done', s?.status === 'done' && s.exit_code === 0, JSON.stringify(s));

console.log('daily limit:');
r = await call('agent_list', {});
const started = r.j?.limits?.started_today;
check('agent_list shows agents and limits', Array.isArray(r.j?.agents) && r.j.agents.length >= 6 && r.j.limits.max_running === 2, r.text.slice(0, 300));
let last;
for (let i = started; i < 9; i++) { last = await call('agent_spawn', { prompt: 'quick', cwd: ROOT }); await waitDone(last.j?.agent_id, 10); }
r = await call('agent_spawn', { prompt: 'one too many', cwd: ROOT });
check('start beyond agents.daily_limit -> DENIED', r.err && /daily_limit/.test(r.text), r.text);

console.log('timeline:');
const evs = await admin('/events?limit=5000');
check('agent.start / agent.end events logged with the task id', evs.some((e) => e.type === 'agent.start' && e.task_id === 'atest') && evs.some((e) => e.type === 'agent.end' && e.status === 'done'));
const st = await admin('/state');
check('status page state lists agents', st.agents?.recent?.length > 0 && st.agents.max_running === 2);

await client.close(); await stopServer();
if (!process.argv.includes('--keep')) { try { fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 6, retryDelay: 200 }); } catch (e) { console.log(`cleanup: ${e.message}`); } } else console.log(`kept ${TMP}`);
if (fail) console.log(serverLog.split('\n').slice(-15).join('\n'));
console.log(`\n${fail ? '\x1b[31m' : '\x1b[32m'}${pass} passed, ${fail} failed\x1b[0m`);
process.exit(fail ? 1 : 0);
