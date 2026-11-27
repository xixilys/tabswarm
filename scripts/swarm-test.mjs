#!/usr/bin/env node
// Tests for `ask` (one prompt -> one answer on any target), named sessions, swarms (parallel
// sub-tasks with retries, fallbacks, dependencies, synthesis, cancel, planner) and the swarm MCP
// tools. No real model is called: web tasks use the mock driver, local agents a fake CLI, the
// gateway a fake HTTP server. Own server on a temp state dir (ports 18801/18802, gateway 18809).
//   node scripts/swarm-test.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { reap, assertPortsFree } from './fixtures/reap.mjs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(HERE, '..');
const CLI = path.join(REPO, 'bin', 'webhub.mjs');
const FAKE = path.join(HERE, 'fixtures', 'fake-agent.sh');
const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tsw-test-')));
const ROOT = path.join(TMP, 'root'), STATE = path.join(TMP, 'state');
for (const d of [ROOT, STATE]) fs.mkdirSync(d, { recursive: true });
const PUB = 18801, ADM = 18802, GW = 18809;
process.env.WEBHUB_STATE_DIR = STATE; process.env.GWM_STATE_DIR = STATE; // for the in-process imports below
const CONFIG = {
  public_port: PUB, admin_port: ADM, roots: [{ name: 'swtest', path: ROOT }], sandbox: false,
  agents: { backends: ['fa', 'fb', 'gateway'], default_backend: 'fa', max_running: 8, timeout_min: 1, commands: { fa: [FAKE, 'fa', '{prompt}'], fb: [FAKE, 'fb', 'FAIL {prompt}'] } },
  gateways: { default: { type: 'anthropic', base_url: `http://127.0.0.1:${GW}`, api_key_env: 'SWTEST_GW_KEY' } },
  models: { planner: 'gateway:plan-model', fast: 'gateway:fast-model' },
  sessions: { max_tool_calls: { gemini: 3 } },
  swarm: { retry_backoff_sec: 1, max_depth: 1 },
  // Never reach a real browser, even if a --driver flag got lost on the way: every web task is
  // mocked, and the browser settings point at an unused port and a throwaway profile.
  gemweb: { driver: 'mock', cdp_url: 'http://127.0.0.1:18898', profile_dir: path.join(TMP, 'no-chrome-profile'), embedded: { enabled: false, fallback_to_chrome: false } },
};
fs.writeFileSync(path.join(STATE, 'config.json'), JSON.stringify(CONFIG));
const ENV = { ...process.env, WEBHUB_STATE_DIR: STATE, GWM_STATE_DIR: STATE, SWTEST_GW_KEY: 'k-test', NO_COLOR: '1' };
process.on('exit', () => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* ignore */ } });

let pass = 0, fail = 0;
const check = (name, ok, detail = '') => { if (ok) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${name}`); } else { fail++; console.log(`  \x1b[31m✗ ${name}\x1b[0m ${String(detail).slice(0, 900)}`); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// async on purpose: the fake gateway lives in this process and must keep answering while a CLI runs
const cli = (args, { input, timeout = 180000 } = {}) => new Promise((resolve) => {
  const ch = spawn(process.execPath, [CLI, ...args], { env: ENV, cwd: ROOT, stdio: ['pipe', 'pipe', 'pipe'] });
  let out = '', err = ''; ch.stdout.on('data', (d) => { out += d; }); ch.stderr.on('data', (d) => { err += d; });
  const t = setTimeout(() => ch.kill('SIGKILL'), timeout);
  ch.on('close', (code) => { clearTimeout(t); resolve({ code, out, err }); });
  if (input != null) ch.stdin.end(input); else ch.stdin.end();
});

// ---------------------------------------------------------------- fake gateway
const gwSeen = [];
const gw = http.createServer(async (req, res) => {
  let b = ''; for await (const c of req) b += c;
  const j = JSON.parse(b || '{}');
  gwSeen.push({ url: req.url, key: req.headers['x-api-key'], body: j });
  const last = j.messages?.[j.messages.length - 1]?.content || '';
  let txt;
  if (/GWFAIL/.test(last)) { res.writeHead(500, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ error: { message: 'upstream exploded' } })); }
  if (/Reply with ONLY a JSON object/.test(last)) txt = '```json\n' + JSON.stringify({ title: 'planned', tasks: [{ id: 'p1', title: 'part one', prompt: 'do part one', backend: 'fa' }, { id: 'p2', title: 'part two', prompt: 'do part two', backend: 'nonsense-backend' }] }) + '\n```';
  else if (/combining the results/.test(last)) txt = `SYNTH of ${(last.match(/^### /gm) || []).length} parts`;
  else txt = `GW(${j.model}) turns=${j.messages.length}: ${last.split('\n').pop().slice(0, 60)}`;
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ model: j.model, content: [{ type: 'text', text: txt }], usage: { input_tokens: 3, output_tokens: 4 } }));
});
await assertPortsFree([GW], 'swarm-test fake gateway');
await new Promise((r) => gw.listen(GW, '127.0.0.1', r));

// ---------------------------------------------------------------- units
console.log('targets:');
const { parseTarget, targetFrom } = await import('../src/targets.js');
const { fillArgv } = await import('../src/agents.js');
const cfg = { ...CONFIG };
const T = (s) => parseTarget(s, cfg);
check('web:gemini:Neon:high', JSON.stringify([T('web:gemini:Neon:high').kind, T('web:gemini:Neon:high').model, T('web:gemini:Neon:high').effort]) === '["web","Neon","high"]');
check('bare "chatgpt" is web', T('chatgpt').kind === 'web' && T('chatgpt').site === 'chatgpt');
check('built-in alias neon -> Gemini web Neon', T('neon').kind === 'web' && T('neon').model === 'Neon');
check('alias + effort: carbon:high', T('carbon:high').model === 'Carbon' && T('carbon:high').effort === 'high');
check('config alias planner -> gateway model', T('planner').kind === 'gateway' && T('planner').model === 'plan-model');
check('gateway@name:model', T('gateway@other:m1').gateway === 'other' && T('gateway@other:m1').model === 'm1');
check('agent backend by name', T('fa').kind === 'agent' && T('agent:fa:m2').model === 'm2');
let threw = false; try { T('nope'); } catch (e) { threw = /unknown target/.test(e.message); } check('unknown target is a usage error', threw);
check('--model/--effort override the spec', targetFrom({ backend: 'web:gemini:Neon', model: 'Carbon', effort: 'low' }, cfg).model === 'Carbon');
check('fillArgv drops an empty optional flag pair', JSON.stringify(fillArgv(['x', '--model', '{model?}', '-p', '{prompt}'], { prompt: 'hi', model: '' })) === '["x","-p","hi"]');
check('fillArgv keeps a set optional value', JSON.stringify(fillArgv(['x', '--model', '{model?}'], { model: 'Neon' })) === '["x","--model","Neon"]');
check('fillArgv {model?sonnet}: fallback when empty, the given value otherwise', JSON.stringify(fillArgv(['x', '--model', '{model?sonnet}'], {})) === '["x","--model","sonnet"]' && JSON.stringify(fillArgv(['x', '--model', '{model?sonnet}'], { model: 'opus' })) === '["x","--model","opus"]');

console.log('sessions (units):');
const S = await import('../src/sessions.js');
const s0 = S.newSession('u1', T('web:gemini'));
S.recordWebTurn(s0, { prompt: 'first ask', task: { id: 't_1', chat_url: 'https://gemini.google.com/app/abc123def', tool_calls: 2, status: 'done', final: { summary: 'did step one' } } });
check('a web turn records chat + tool calls', s0.chat_url.endsWith('abc123def') && s0.chat_tool_calls === 2 && s0.chats.length === 1);
check('under the budget: same chat', S.needsRollover(s0, cfg) === false);
S.recordWebTurn(s0, { prompt: 'second', task: { id: 't_2', chat_url: 'https://gemini.google.com/app/abc123def', tool_calls: 2, status: 'done', final: { summary: 'did step two' } } });
check('budget reached (4 >= 3): next turn rolls over', S.needsRollover(s0, cfg) === true);
const hp = S.handoffPrompt(s0, 'third', cfg);
check('handoff carries the original request, progress and the new message', /HANDOFF/.test(hp) && /first ask/.test(hp) && /did step two/.test(hp) && /NEW MESSAGE:\nthird/.test(hp), hp);

console.log('end to end:');
await assertPortsFree([PUB, ADM], 'swarm-test');
const server = reap(spawn(process.execPath, [path.join(REPO, 'src', 'server.js')], { env: ENV, stdio: 'ignore' }));
for (let i = 0; i < 60; i++) { if (await fetch(`http://127.0.0.1:${ADM}/api/state`).then((r) => r.ok).catch(() => false)) break; await sleep(200); }
const secrets = JSON.parse(fs.readFileSync(path.join(STATE, 'secrets.json'), 'utf8'));
const adm = (p, o = {}) => fetch(`http://127.0.0.1:${ADM}/api${p}`, { ...o, headers: { 'content-type': 'application/json', authorization: `Bearer ${secrets.admin_token}` } }).then((r) => r.json());

// ask: gateway
let r = await cli(['ask', '--backend', 'fast', 'hello there']);
check('ask gateway: answer only on stdout, exit 0', r.code === 0 && /^GW\(fast-model\) turns=1: hello there\n$/.test(r.out), JSON.stringify(r));
check('gateway got the key from api_key_env', gwSeen.some((x) => x.key === 'k-test'));
r = await cli(['ask', '--backend', 'gateway:m1', '--json'], { input: 'from stdin' });
check('ask reads the prompt from stdin; --json result', r.code === 0 && JSON.parse(r.out).answer.includes('from stdin') && JSON.parse(r.out).kind === 'gateway', r.out + r.err);
await cli(['ask', '--backend', 'gateway:m1', '--session', 'g1', 'turn one']);
r = await cli(['ask', '--backend', 'gateway:m1', '--session', 'g1', 'turn two']);
check('gateway session sends the history (3 messages on turn 2)', /turns=3: turn two/.test(r.out), r.out + r.err);
r = await cli(['ask', '--backend', 'gateway:m1', 'GWFAIL now']);
check('gateway error -> exit 4 with the reason on stderr', r.code === 4 && /upstream exploded/.test(r.err), JSON.stringify(r));
r = await cli(['ask', '--backend', 'bogus:thing', 'x']);
check('bad target -> exit 2', r.code === 2, JSON.stringify(r));

// ask: web (mock driver)
const wdir = path.join(ROOT, 'web1'); fs.mkdirSync(wdir);
r = await cli(['ask', '--backend', 'web:gemini', '--driver', 'mock', '--cwd', wdir, `MOCK run ${wdir} :: echo mock-says-hi > hi.txt && cat hi.txt`]);
check('ask web (mock): final answer on stdout, exit 0', r.code === 0 && /mock run for t_\w+ finished/.test(r.out) && /mock-says-hi/.test(r.out), JSON.stringify(r));
check('ask web: details (task id) on stderr only', /task: t_/.test(r.err) && !/task: t_/.test(r.out));
r = await cli(['ask', '--backend', 'web:gemini', '--driver', 'mock', '--json', `MOCK run ${wdir} :: false`]);
const rj = JSON.parse(r.out || '{}');
check('ask web: a blocked report -> exit 3, status blocked', r.code === 3 && rj.status === 'blocked', r.out + r.err);

// ask: local agent through the hub
const adir = path.join(ROOT, 'agent1'); fs.mkdirSync(adir);
r = await cli(['ask', '--backend', 'fa', '--cwd', adir, 'build the thing']);
check('ask local agent: the agent answer, exit 0', r.code === 0 && /FINAL: fa finished: build the thing/.test(r.out) && fs.existsSync(path.join(adir, 'agent-fa.txt')), JSON.stringify(r));
r = await cli(['ask', '--backend', 'fb', '--cwd', adir, 'x']);
check('ask local agent failure -> exit 4', r.code === 4, JSON.stringify(r));

// swarm: deps, fallback retry, web + gateway + agent, synthesis
const sdir = path.join(ROOT, 'sw1'); fs.mkdirSync(sdir);
const plan = {
  title: 'mixed swarm', goal: 'test goal', cwd: sdir, concurrency: 3,
  tasks: [
    { id: 'a', prompt: 'gateway part', backend: 'fast' },
    { id: 'b', prompt: 'agent part', backend: 'fa' },
    { id: 'd', prompt: 'flaky part', backend: 'fb', fallback: ['fa'] },
    { id: 'c', prompt: `MOCK run ${sdir} :: echo web-part-done`, backend: 'web:gemini', depends_on: ['a', 'b'] },
  ],
  synthesize: { backend: 'fast' },
};
fs.writeFileSync(path.join(TMP, 'plan.json'), JSON.stringify(plan));
r = await cli(['swarm', 'start', path.join(TMP, 'plan.json'), '--driver', 'mock', '--wait', '--timeout', '150']);
const swId = (/\[swarm (sw_[0-9a-f]+)\]/.exec(r.err) || [])[1];
check('swarm start --wait finishes done (exit 0) with the synthesis on stdout', r.code === 0 && /SYNTH of 4 parts/.test(r.out), JSON.stringify(r).slice(0, 1500));
const { loadSwarm, swarmDir } = await import('../src/swarm.js');
const st = swId && loadSwarm(swId);
const tk = (id) => st?.tasks.find((t) => t.id === id);
check('every sub-task done', st && ['a', 'b', 'c', 'd'].every((id) => tk(id).status === 'done'), JSON.stringify(st?.tasks.map((t) => [t.id, t.status, t.error])));
check('failed attempt retried on the fallback backend', tk('d')?.attempts.length === 2 && tk('d').attempts[0].target === 'fb' && tk('d').attempts[1].target === 'fa', JSON.stringify(tk('d')?.attempts));
const cPrompt = st ? fs.readFileSync(path.join(swarmDir(swId), 'tasks', 'c', 'prompt-1.txt'), 'utf8') : '';
check('dependent task got the goal and both earlier answers', /test goal/.test(cPrompt) && /### a:/.test(cPrompt) && /GW\(fast-model\)/.test(cPrompt) && /FINAL: fa finished/.test(cPrompt), cPrompt.slice(0, 600));
check('dependent task started after its dependencies ended', st && Date.parse(tk('c').attempts[0].started) >= Math.max(Date.parse(tk('a').attempts[0].ended), Date.parse(tk('b').attempts[0].ended)));
check('web sub-task ran as a hub task', /^t_/.test(tk('c')?.attempts[0].task_id || ''), JSON.stringify(tk('c')?.attempts));
r = await cli(['swarm', 'status', swId, '--json']);
const sj = JSON.parse(r.out || '{}');
check('swarm status --json: counts and per-task rows', sj.counts?.done === 5 && sj.tasks?.length === 5, r.out.slice(0, 500));
const evs = await adm(`/events?task_id=swarm:${swId}`);
check('swarm events reached the hub timeline', Array.isArray(evs) && evs.some((e) => e.type === 'swarm.end') && evs.some((e) => e.type === 'swarm.task_retry'), JSON.stringify(evs).slice(0, 300));
const stateSw = (await adm('/state')).swarms || [];
check('hub state lists the swarm', stateSw.some((x) => x.id === swId));

// swarm: cancel
const cplan = { title: 'to cancel', cwd: sdir, tasks: [{ id: 'h', prompt: 'HANG forever', backend: 'fa' }, { id: 'h2', prompt: 'HANG too', backend: 'fa' }], synthesize: false };
fs.writeFileSync(path.join(TMP, 'cplan.json'), JSON.stringify(cplan));
r = await cli(['swarm', 'start', path.join(TMP, 'cplan.json')]);
const cId = r.out.trim();
for (let i = 0; i < 30 && loadSwarm(cId)?.tasks.some((t) => t.status !== 'running'); i++) await sleep(500);
const askPid = loadSwarm(cId)?.tasks[0].attempts[0]?.pid;
await sleep(2500);
await cli(['swarm', 'cancel', cId]);
for (let i = 0; i < 30 && loadSwarm(cId)?.status === 'running'; i++) await sleep(500);
await sleep(1500);
let alive = true; try { process.kill(askPid, 0); } catch { alive = false; }
const agentsNow = (await adm('/state')).agents?.recent || [];
check('cancel: swarm and its tasks cancelled', loadSwarm(cId)?.status === 'cancelled' && loadSwarm(cId).tasks.every((t) => t.status === 'cancelled'), JSON.stringify(loadSwarm(cId)?.tasks.map((t) => t.status)));
check('cancel: the attempt process is gone and its agent stopped', !alive && !agentsNow.some((a) => a.status === 'running'), JSON.stringify(agentsNow.slice(0, 3)));

// swarm: planner
r = await cli(['swarm', 'plan', '--planner', 'planner', '--workers', 'fa,fast', '--cwd', sdir, '--run', '--wait', '--timeout', '120', 'make a plan for x']);
check('swarm plan --run --wait: planner JSON -> tasks run -> synthesis', r.code === 0 && /SYNTH of 2 parts/.test(r.out), JSON.stringify(r).slice(0, 1200));
const pId = (/\[swarm (sw_[0-9a-f]+)\]/.exec(r.err) || [])[1];
const ps = pId && loadSwarm(pId);
check('an unknown backend from the planner is replaced by a listed worker', ps && ps.tasks.find((t) => t.id === 'p2')?.backend === 'fast', JSON.stringify(ps?.tasks.map((t) => [t.id, t.backend])));

// limits
const { createSwarm } = await import('../src/swarm.js');
let denied = false; try { createSwarm(plan, { ...CONFIG }, { depth: 2 }); } catch (e) { denied = /max_depth/.test(e.message); }
check('a swarm deeper than swarm.max_depth is refused', denied);
let cyc = false; try { createSwarm({ tasks: [{ id: 'x', prompt: 'p', depends_on: ['y'] }, { id: 'y', prompt: 'p', depends_on: ['x'] }] }, { ...CONFIG }); } catch (e) { cyc = /cycle/.test(e.message); }
check('a dependency cycle is refused', cyc);

// MCP tools
console.log('MCP tools:');
const client = new Client({ name: 'swarm-test', version: '1.0.0' });
await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${PUB}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${secrets.static_bearer}` } } }));
const call = async (name, args) => { const x = await client.callTool({ name, arguments: args }); return { err: !!x.isError, text: x.content.map((c) => c.text).join('\n') }; };
const tools = (await client.listTools()).tools.map((t) => t.name);
check('swarm_start / swarm_status / swarm_result are offered', ['swarm_start', 'swarm_status', 'swarm_result'].every((n) => tools.includes(n)), tools.join(','));
let x = await call('swarm_start', { title: 'via mcp', cwd: sdir, tasks: [{ id: 'm1', prompt: 'one', backend: 'fast' }, { id: 'm2', prompt: 'two', backend: 'fa' }], synthesize: { backend: 'fast' }, task_id: 'mcp_swarm' });
const mId = (/"swarm_id": "(sw_[0-9a-f]+)"/.exec(x.text) || [])[1];
check('swarm_start returns a swarm id', !x.err && !!mId, x.text);
let status = '';
for (let i = 0; i < 6; i++) { x = await call('swarm_status', { swarm_id: mId, wait_sec: 20, task_id: 'mcp_swarm' }); status = JSON.parse(x.text).status; if (status !== 'running') break; }
check('swarm_status(wait_sec) reaches done in a few calls', status === 'done', x.text.slice(0, 400));
x = await call('swarm_result', { swarm_id: mId, task_id: 'mcp_swarm' });
check('swarm_result has per-task answers and the synthesis', /SYNTH of 2 parts/.test(x.text) && /GW\(fast-model\)/.test(x.text), x.text.slice(0, 500));
x = await call('swarm_start', { cwd: '/etc', tasks: [{ prompt: 'x', backend: 'fa' }], task_id: 'mcp_swarm' });
check('swarm_start outside the roots is refused', x.err, x.text);
x = await call('agent_spawn', { prompt: 'quick one', cwd: adir, backend: 'fa', task_id: 'mcp_swarm' });
const agId = (/"agent_id": "(ag_[0-9a-f]+)"/.exec(x.text) || [])[1];
const t0 = Date.now();
x = await call('agent_status', { agent_id: agId, wait_sec: 30, task_id: 'mcp_swarm' });
check('agent_status(wait_sec) returns once the agent is done', JSON.parse(x.text).status === 'done' && Date.now() - t0 < 25000, x.text.slice(0, 300));
await client.close();

gw.close();
const realTasks = (await adm('/tasks')).filter((t) => t.origin === 'gemweb' && !t.mock); // dispatched web tasks (not manual MCP sessions)
check('no web task of this suite used a real browser (all mock)', realTasks.length === 0, JSON.stringify(realTasks.map((t) => [t.id, t.status, t.from])));
console.log(`\n${fail ? '\x1b[31m' : '\x1b[32m'}${pass} passed, ${fail} failed\x1b[0m`);
process.exit(fail ? 1 : 0);
