#!/usr/bin/env node
// Tests for Web AI Hub monitoring & concurrency features:
// - UI <script> syntax + dashboard HTTP rendering
// - Per-site 3-way concurrency + FIFO queuing in Slots
// - In-flight MCP tool call tracking + running shell job kill via admin API & `webhub ps/kill`
// - Task cancellation (`POST /api/tasks/:id/cancel`): kills job, closes task tabs, blocks further MCP calls
// - Un-tagged MCP calls split cleanly per OAuth client (`Google` -> manual_gemini_*, `ChatGPT` -> manual_chatgpt_*)
// - Tab correlation & `?probe=1` via `/api/browser/tabs` + `webhub browser tabs` + `webhub trace` + `/view` sanitization
// - Direct dispatch from the dashboard (`POST /api/dispatch`): auth, validation, out-of-root cwd, mock web task, local agent
// Own isolated server (ports 18783/18784, temp state dir) + isolated headless Chrome (CDP 19232).
import './fixtures/fake-clock.mjs'; // pinned local day: a run crossing midnight cannot change "today" mid-test
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { reap, assertPortsFree } from './fixtures/reap.mjs';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(HERE, '..');
const WEBHUB = path.join(REPO, 'bin', 'webhub.mjs');
const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gwm-htest-')));
const ROOT = path.join(TMP, 'root');
const STATE = path.join(TMP, 'state');
fs.mkdirSync(ROOT, { recursive: true });
fs.mkdirSync(STATE, { recursive: true });
process.env.WEBHUB_STATE_DIR = STATE;
process.env.GWM_STATE_DIR = STATE;

const PUB = 18783, ADM = 18784, CDP_PORT = 19232, CDP = `http://127.0.0.1:${CDP_PORT}`;
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

let pass = 0, fail = 0;
const check = (name, ok, detail = '') => {
  if (ok) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${name}`); }
  else { fail++; console.log(`  \x1b[31m✗ ${name}\x1b[0m ${String(detail).slice(0, 700)}`); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const txt = (r) => (r.content || []).map((x) => x.text).join('\n');

const { startFakeGemini } = await import('./fixtures/fake-gemini.mjs');
const { startFakeChatgpt } = await import('./fixtures/fake-chatgpt.mjs');
const fakeGem = await startFakeGemini({ runMock: async () => {} });
const fakeGpt = await startFakeChatgpt({ runMock: async () => {} });

fs.writeFileSync(path.join(STATE, 'config.json'), JSON.stringify({
  public_port: PUB,
  admin_port: ADM,
  roots: [{ name: 'htest', path: ROOT }],
  gemweb: {
    concurrency: 3,
    min_interval_sec: 0,
    daily_limit: 30,
    headless: true,
    browser_mode: 'chrome', // the embedded (desktop app) browser has its own test: embedded-test.mjs
    cdp_url: CDP,
    profile_dir: path.join(TMP, 'chrome-profile'),
    gemini_url: fakeGem.url,
    chatgpt: { url: fakeGpt.url, idle_sec: 3 },
    operator_models: [],
  },
  agents: {
    backends: ['dsh', 'claude', 'codex', 'web-chatgpt', 'web-gemini', 'echo'],
    commands: { echo: ['/bin/sh', '-c', 'echo agent-ok; sleep 1'] },
  },
}));

const { loadConfig } = await import('../src/config.js');
const cfgRef = loadConfig();

let chromeProc = null, server = null, serverLog = '';
const clients = [];

try {
  // ---------------- 1. UI script syntax & Slots 3-way unit tests ----------------
  console.log('UI script syntax & per-site concurrency:');
  const html = fs.readFileSync(path.join(REPO, 'src', 'ui', 'status.html'), 'utf8');
  const m = /<script>([\s\S]*?)<\/script>/.exec(html);
  let jsValid = false;
  try {
    if (m) new Function(m[1]);
    jsValid = !!m;
  } catch (e) {
    jsValid = false;
  }
  check('status.html <script> parses cleanly', jsValid);

  const { Slots } = await import('../src/slots.js');
  const recs = new Map([
    ['g1', { id: 'g1', site: 'gemini' }],
    ['g2', { id: 'g2', site: 'gemini' }],
    ['g3', { id: 'g3', site: 'gemini' }],
    ['g4', { id: 'g4', site: 'gemini' }],
    ['c1', { id: 'c1', site: 'chatgpt' }],
  ]);
  const sl = new Slots(
    { gemweb: { concurrency: 3, min_interval_sec: 0 } },
    { get: (id) => recs.get(id), isActive: () => true, setStatus() {} },
    { emit() {} },
  );
  const g1 = await sl.acquire(recs.get('g1'), 0);
  const g2 = await sl.acquire(recs.get('g2'), 0);
  const g3 = await sl.acquire(recs.get('g3'), 0);
  const g4 = await sl.acquire(recs.get('g4'), 120);
  const c1 = await sl.acquire(recs.get('c1'), 0);
  const sum = sl.summary();
  check(
    '3 concurrent Gemini slots granted, 4th queues FIFO, ChatGPT independent',
    g1.granted && g2.granted && g3.granted && !g4.granted && g4.position === 1 && c1.granted
      && sum.by_site.gemini.running.length === 3 && sum.by_site.gemini.queued.length === 1 && sum.by_site.chatgpt.running.length === 1,
    JSON.stringify({ g4, sum }),
  );
  for (const id of ['g1', 'g2', 'g3', 'g4', 'c1']) sl.release(id);

  // ---------------- 2. Start isolated Chrome + server ----------------
  await assertPortsFree([PUB, ADM, CDP_PORT], 'hub-monitor-test');
  chromeProc = reap(spawn(CHROME, [
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${path.join(TMP, 'chrome-profile')}`,
    '--use-mock-keychain', '--password-store=basic',
    '--no-first-run', '--no-default-browser-check', '--headless=new', 'about:blank',
  ], { stdio: 'ignore' }));
  for (let i = 0; i < 60; i++) {
    if (await fetch(`${CDP}/json/version`).then((r) => r.ok).catch(() => false)) break;
    await sleep(200);
  }

  server = reap(spawn(process.execPath, [path.join(REPO, 'src', 'server.js')], {
    // GEMWEB_DRIVER=mock: web tasks dispatched from the dashboard (webhub run) use the offline mock driver
    env: { ...process.env, WEBHUB_STATE_DIR: STATE, GWM_STATE_DIR: STATE, GEMWEB_DRIVER: 'mock' },
    stdio: ['ignore', 'pipe', 'pipe'],
  }));
  server.stdout.on('data', (d) => { serverLog += d; });
  server.stderr.on('data', (d) => { serverLog += d; });
  for (let i = 0; i < 50; i++) {
    if (await fetch(`http://127.0.0.1:${ADM}/api/state`).then((r) => r.ok).catch(() => false)) break;
    await sleep(200);
  }

  const secrets = JSON.parse(fs.readFileSync(path.join(STATE, 'secrets.json'), 'utf8'));
  const api = async (p, o = {}) => {
    const r = await fetch(`http://127.0.0.1:${ADM}/api${p}`, {
      method: o.method || 'GET',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${secrets.admin_token}` },
      body: o.body ? JSON.stringify(o.body) : undefined,
    });
    const j = await r.json().catch(() => ({}));
    return { status: r.status, ok: r.ok, data: j };
  };
  const webhub = (args) => new Promise((resolve) => {
    const ch = spawn(process.execPath, [WEBHUB, ...args], {
      env: { ...process.env, WEBHUB_STATE_DIR: STATE, GWM_STATE_DIR: STATE, NO_COLOR: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '', err = '';
    ch.stdout.on('data', (d) => { out += d; });
    ch.stderr.on('data', (d) => { err += d; });
    ch.on('close', (code) => resolve({ code, out, err }));
  });

  // Dashboard HTML check
  const dash = await fetch(`http://127.0.0.1:${ADM}/`);
  const dashBody = await dash.text();
  check('dashboard returns 200 with Chinese UI & GWM boot config', dash.status === 200 && dashBody.includes('网页 AI 控制台') && dashBody.includes('实时总览') && dashBody.includes('window.GWM='));

  // ---------------- 3. In-flight MCP + running job + kill ----------------
  console.log('in-flight MCP tracking & running process kill:');
  const staticClient = new Client({ name: 'htest-static', version: '1' });
  await staticClient.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${PUB}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${secrets.static_bearer}` } },
  }));
  clients.push(staticClient);

  const pendingCall = staticClient.callTool({
    name: 'run_command',
    arguments: { task_id: 'htest_job', cwd: ROOT, command: 'echo start_marker; sleep 30; echo end_marker', wait_seconds: 15, timeout_seconds: 60 },
  });

  let midState = null, activeJob = null;
  for (let i = 0; i < 30; i++) {
    midState = (await api('/state')).data;
    activeJob = (midState.jobs?.running || []).find((j) => j.task_id === 'htest_job');
    if (midState.in_flight?.some((x) => x.task_id === 'htest_job' && x.tool === 'run_command') && activeJob) break;
    await sleep(150);
  }
  check(
    'state.in_flight and state.jobs.running expose active MCP call and local PID',
    !!midState?.in_flight?.some((x) => x.task_id === 'htest_job' && x.tool === 'run_command')
      && !!activeJob?.pid && activeJob.cwd === ROOT && /sleep 30/.test(activeJob.command),
    JSON.stringify({ in_flight: midState?.in_flight, activeJob }),
  );

  const psText = await webhub(['ps']);
  const psJson = await webhub(['ps', '--json']);
  let psParsed = null;
  try { psParsed = JSON.parse(psJson.out); } catch { /* ignore */ }
  check('webhub ps shows in-flight MCP calls and running job', psText.code === 0 && psText.out.includes('执行中的 MCP 工具') && psText.out.includes(activeJob?.job_id || 'job_'), psText.out + psText.err);
  check('webhub ps --json returns matching snapshot', psJson.code === 0 && psParsed?.jobs?.running?.some((j) => j.job_id === activeJob?.job_id), psJson.err);

  const killRes = await webhub(['kill', activeJob.job_id]);
  check('webhub kill <job_id> stops running shell job', killRes.code === 0 && killRes.out.includes(`killed job ${activeJob.job_id}`), killRes.out + killRes.err);

  const callDone = await pendingCall;
  check('killed command unblocks MCP call promptly with killed status', /killed/.test(txt(callDone)), txt(callDone));
  await sleep(150);
  const afterKill = (await api('/state')).data;
  check('in_flight and jobs.running clear after job kill', afterKill.in_flight.length === 0 && afterKill.jobs.running.length === 0, JSON.stringify({ in_flight: afterKill.in_flight, jobs: afterKill.jobs }));

  // ---------------- 4. Task cancel kills bg jobs, closes tabs, blocks MCP ----------------
  console.log('task cancel (jobs + tabs + MCP cutoff):');
  const created = (await api('/tasks', { method: 'POST', body: { prompt: 'long work to cancel', from: 'htest', site: 'gemini', mock: true } })).data;
  const { Dedicated } = await import('../src/browser.js');
  const ded = await Dedicated.connect(cfgRef, created.id);
  const tabPage = await ded.newPage();
  await tabPage.goto('about:blank');
  await api(`/tasks/${created.id}/update`, { method: 'POST', body: { status: 'running', stage: 'generating', driver: { site: 'gemini' } } });

  // /json/list can lag a moment behind a just-created background target: poll briefly.
  let tabsBefore = null;
  for (let i = 0; i < 20; i++) {
    tabsBefore = (await api('/browser/tabs')).data;
    if (tabsBefore.tabs?.some((tb) => tb.task_id === created.id)) break;
    await sleep(150);
  }
  check('open tab correlated to task with stage=generating & mode=task', tabsBefore.tabs.some((tb) => tb.task_id === created.id && tb.stage === 'generating' && tb.mode === 'task'), JSON.stringify(tabsBefore.tabs));

  const bgStart = await staticClient.callTool({
    name: 'run_command',
    arguments: { task_id: created.id, cwd: ROOT, command: 'sleep 30', wait_seconds: 1, timeout_seconds: 60 },
  });
  const bgJobId = /job_id="(job_[a-f0-9]+)"/.exec(txt(bgStart))?.[1];
  check('background job started for task before cancel', !!bgJobId, txt(bgStart));

  const cancelRes = await webhub(['cancel', created.id]);
  check('webhub cancel reports killed job and closed tab', cancelRes.code === 0 && /killed 1 job/.test(cancelRes.out) && /closed 1 tab/.test(cancelRes.out), cancelRes.out + cancelRes.err);

  const postCancelCall = await staticClient.callTool({ name: 'list_dir', arguments: { task_id: created.id, path: ROOT } });
  check('subsequent MCP call for cancelled task is refused', !!postCancelCall.isError && /STOPPED: task .* was cancelled/.test(txt(postCancelCall)), txt(postCancelCall));
  const tabsAfterCancel = (await api('/browser/tabs')).data;
  check('cancelled task tab removed from Chrome', !tabsAfterCancel.tabs.some((tb) => tb.task_id === created.id), JSON.stringify(tabsAfterCancel.tabs));
  await ded.disconnect();

  // ---------------- 5. Un-tagged MCP calls split per OAuth client ----------------
  console.log('manual chat separation per OAuth client (Google vs ChatGPT):');
  async function connectOAuthClient(clientName) {
    const redirect = 'http://127.0.0.1/cb';
    const reg = await fetch(`http://127.0.0.1:${PUB}/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ client_name: clientName, redirect_uris: [redirect], token_endpoint_auth_method: 'client_secret_post' }),
    }).then((r) => r.json());
    const verifier = crypto.randomBytes(32).toString('base64url');
    const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
    const q = { response_type: 'code', client_id: reg.client_id, redirect_uri: redirect, state: 's1', code_challenge: challenge, code_challenge_method: 'S256', scope: 'mcp' };
    const authRes = await fetch(`http://127.0.0.1:${PUB}/authorize`, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ ...q, passcode: secrets.passcode }),
    });
    const code = new URL(authRes.headers.get('location')).searchParams.get('code');
    const tok = await fetch(`http://127.0.0.1:${PUB}/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: reg.client_id, client_secret: reg.client_secret, grant_type: 'authorization_code', code, redirect_uri: redirect, code_verifier: verifier }),
    }).then((r) => r.json());
    const mc = new Client({ name: clientName, version: '1' });
    await mc.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${PUB}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${tok.access_token}` } },
    }));
    clients.push(mc);
    return mc;
  }

  const googleClient = await connectOAuthClient('Google');
  const chatgptClient = await connectOAuthClient('ChatGPT');
  await googleClient.callTool({ name: 'list_roots', arguments: {} });
  await chatgptClient.callTool({ name: 'list_roots', arguments: {} });
  const tasksList = (await api('/tasks')).data;
  const mGem = tasksList.find((t) => t.origin === 'mcp' && t.id.startsWith('manual_gemini_') && t.site === 'gemini');
  const mGpt = tasksList.find((t) => t.origin === 'mcp' && t.id.startsWith('manual_chatgpt_') && t.site === 'chatgpt');
  check('un-tagged MCP calls create separate manual_gemini_* and manual_chatgpt_* sessions', !!mGem && !!mGpt && mGem.id !== mGpt.id, JSON.stringify({ mGem, mGpt }));

  // ---------------- 6. Live browser probe + CLI tabs/trace + /view sanitization ----------------
  console.log('tab probing, CLI trace & remote /view sanitization:');
  const oGem = (await api('/browser/open', { method: 'POST', body: { site: 'gemini', bring_to_front: false } })).data;
  const oGpt = (await api('/browser/open', { method: 'POST', body: { site: 'chatgpt', bring_to_front: false } })).data;
  const probed = (await api('/browser/tabs?probe=1')).data;
  const gemTab = probed.tabs.find((tb) => tb.target_id === oGem.target_id);
  const gptTab = probed.tabs.find((tb) => tb.target_id === oGpt.target_id);
  check(
    'GET /api/browser/tabs?probe=1 classifies & probes fake Gemini and ChatGPT tabs',
    probed.running === true && gemTab?.site === 'gemini' && gemTab?.stage === 'idle' && gemTab?.mode === 'manual'
      && gptTab?.site === 'chatgpt' && gptTab?.stage === 'idle' && gptTab?.mode === 'manual',
    JSON.stringify(probed.tabs),
  );

  const cliTabs = await webhub(['browser', 'tabs', '--probe']);
  check('webhub browser tabs --probe prints open tabs', cliTabs.code === 0 && cliTabs.out.includes('gemini') && cliTabs.out.includes('chatgpt'), cliTabs.out + cliTabs.err);

  if (oGem.target_id) await api('/browser/close', { method: 'POST', body: { target_id: oGem.target_id } });
  if (oGpt.target_id) await api('/browser/close', { method: 'POST', body: { target_id: oGpt.target_id } });
  const afterClose = (await api('/browser/tabs')).data;
  check('POST /api/browser/close removes tabs', !afterClose.tabs.some((tb) => tb.target_id === oGem.target_id || tb.target_id === oGpt.target_id), JSON.stringify(afterClose.tabs));

  const trOut = await webhub(['trace', 'htest_job']);
  const trJson = await webhub(['trace', 'htest_job', '--json']);
  let trParsed = null;
  try { trParsed = JSON.parse(trJson.out); } catch { /* ignore */ }
  check('webhub trace shows full MCP audit and JSON output', trOut.code === 0 && trOut.out.includes('run_command') && trParsed?.task?.id === 'htest_job' && trParsed?.events?.length >= 2, trOut.out + trOut.err);

  const loginRes = await fetch(`http://127.0.0.1:${PUB}/view/login`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ passcode: secrets.passcode }),
  });
  const cookie = (loginRes.headers.get('set-cookie') || '').split(';')[0];
  const viewState = await fetch(`http://127.0.0.1:${PUB}/view/api/state`, { headers: { cookie } }).then((r) => r.json());
  check('/view/api/state strips local profile_dir and pid while keeping browser tabs', Array.isArray(viewState.browser?.tabs) && viewState.browser.profile_dir === undefined && viewState.browser.pid === undefined, JSON.stringify(viewState.browser));
  // ---------------- 7. Direct dispatch from the dashboard ----------------
  console.log('direct dispatch (POST /api/dispatch):');
  const noAuth = await fetch(`http://127.0.0.1:${ADM}/api/dispatch`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt: 'hi' }) });
  check('POST /api/dispatch without admin token or page token is refused with 403', noAuth.status === 403, noAuth.status);
  const pageTok = /"csrf":"([^"]+)"/.exec(dashBody)?.[1];
  const withPageTok = await fetch(`http://127.0.0.1:${ADM}/api/dispatch`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-gwm-csrf': pageTok || 'x' }, body: JSON.stringify({ prompt: '' }) });
  check('page CSRF token is accepted and an empty prompt is rejected with 400', withPageTok.status === 400 && /prompt required/.test((await withPageTok.json()).error || ''), withPageTok.status);
  const blank = await api('/dispatch', { method: 'POST', body: { prompt: '   ', site: 'gemini' } });
  check('whitespace-only prompt is rejected with 400 prompt required', blank.status === 400 && blank.data.error === 'prompt required', JSON.stringify(blank));
  const badSite = await api('/dispatch', { method: 'POST', body: { prompt: 'x', site: 'bard' } });
  check('unknown web site is rejected with 400', badSite.status === 400 && badSite.data.ok === false, JSON.stringify(badSite));
  const outside = await api('/dispatch', { method: 'POST', body: { prompt: 'x', site: 'chatgpt', cwd: os.homedir() } });
  check('web dispatch with cwd outside the allowed roots is rejected (403)', outside.status === 403 && /outside allowed roots/.test(outside.data.error || ''), JSON.stringify(outside));
  const outsideAgent = await api('/dispatch', { method: 'POST', body: { prompt: 'x', target: 'agent', backend: 'echo', cwd: '/etc' } });
  check('agent dispatch with cwd outside the allowed roots is rejected (403)', outsideAgent.status === 403 && outsideAgent.data.ok === false, JSON.stringify(outsideAgent));
  const badBackend = await api('/dispatch', { method: 'POST', body: { prompt: 'x', backend: 'rm-rf' } });
  check('agent dispatch with a backend that is not allowed is refused (403)', badBackend.status === 403 && /not allowed/.test(badBackend.data.error || ''), JSON.stringify(badBackend));

  fs.mkdirSync(path.join(ROOT, 'sub'), { recursive: true });
  const webD = await api('/dispatch', { method: 'POST', body: { target: 'web', site: 'gemini', prompt: 'MOCK run sub :: echo ui_dispatch_marker', cwd: 'sub', model: '4 Neon' } });
  check('web dispatch spawns webhub run --no-wait and returns the new task id', webD.status === 200 && webD.data.ok === true && webD.data.mode === 'web' && /^t_[0-9a-f]+$/.test(webD.data.task_id || ''), JSON.stringify(webD));
  let webTask = null;
  for (let i = 0; i < 60 && webD.data.task_id; i++) {
    webTask = (await api(`/tasks/${webD.data.task_id}`)).data;
    if (webTask.final) break;
    await sleep(250);
  }
  check('dispatched web task is recorded from "ui" with resolved cwd and finishes via the mock driver',
    webTask?.from === 'ui' && webTask?.site === 'gemini' && webTask?.cwd === path.join(ROOT, 'sub') && webTask?.final?.status === 'final',
    JSON.stringify({ from: webTask?.from, site: webTask?.site, cwd: webTask?.cwd, status: webTask?.status, final: webTask?.final }));
  const leftover = fs.readdirSync(path.join(STATE, 'run')).filter((f) => f.startsWith('ui-prompt-'));
  check('temporary ui-prompt file is removed after dispatch', leftover.length === 0, leftover.join(','));

  const limitD = await api('/dispatch', { method: 'POST', body: { site: 'chatgpt', prompt: 'x', account: 'nope' } });
  check('web dispatch to an unknown account returns ok:false with the refusal reason', [400, 429].includes(limitD.status) && limitD.data.ok === false && !!limitD.data.error, JSON.stringify(limitD));

  const agD = await api('/dispatch', { method: 'POST', body: { target: 'agent', backend: 'echo', prompt: 'say ok', timeout_min: 1 } });
  check('agent dispatch starts a local agent in the first root', agD.status === 200 && agD.data.ok === true && agD.data.mode === 'agent' && /^ag_/.test(agD.data.agent_id || '') && agD.data.backend === 'echo' && agD.data.cwd === ROOT, JSON.stringify(agD));
  let agState = null;
  for (let i = 0; i < 20; i++) {
    agState = (await api('/state')).data.agents;
    if (agState?.active?.some((a) => a.id === agD.data.agent_id && /agent-ok/.test(a.stdout_tail || ''))) break;
    await sleep(150);
  }
  const agRow = agState?.active?.find((a) => a.id === agD.data.agent_id);
  check('state.agents.active exposes the running agent with pid, prompt and stdout tail', !!agRow?.pid && /say ok/.test(agRow.prompt_preview || '') && /agent-ok/.test(agRow.stdout_tail || ''), JSON.stringify(agState?.active));
  for (let i = 0; i < 30; i++) {
    const r = (await api('/state')).data.agents.recent.find((a) => a.id === agD.data.agent_id);
    if (r && r.status !== 'running') { check('dispatched agent finishes with status done', r.status === 'done', JSON.stringify(r)); break; }
    if (i === 29) check('dispatched agent finishes with status done', false, 'still running');
    await sleep(250);
  }

  console.log('late report vs driver timeout:');
  {
    const rt = (await api('/tasks', { method: 'POST', body: { prompt: 'race final vs timeout', from: 'htest', site: 'gemini', mock: true } })).data;
    await api(`/tasks/${rt.id}/update`, { method: 'POST', body: { status: 'running' } });
    await staticClient.callTool({ name: 'report', arguments: { task_id: rt.id, status: 'final', summary: 'race final', content: 'ok' } });
    await api(`/tasks/${rt.id}/update`, { method: 'POST', body: { status: 'timeout', stage: 'idle', error: 'no report(final) within 1s' } });
    const after = (await api(`/tasks/${rt.id}`)).data;
    check('report(final) that lands before the driver posts timeout keeps the task done', after.status === 'done' && after.final?.summary === 'race final' && !after.error, JSON.stringify({ status: after.status, error: after.error }));
  }
} finally {
  for (const c of clients) await c.close().catch(() => {});
  const stopChild = (ch) => new Promise((resolve) => {
    if (!ch || ch.exitCode !== null || ch.signalCode !== null) return resolve();
    const timer = setTimeout(() => { try { ch.kill('SIGKILL'); } catch { /* */ } resolve(); }, 3000);
    ch.once('close', () => { clearTimeout(timer); resolve(); });
    try { ch.kill('SIGTERM'); } catch { clearTimeout(timer); resolve(); }
  });
  await Promise.all([stopChild(server), stopChild(chromeProc), fakeGem.close().catch(() => {}), fakeGpt.close().catch(() => {})]);
  await sleep(200);
  if (!process.argv.includes('--keep')) fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 6, retryDelay: 200 });
  else console.log(`kept ${TMP}`);
}

if (fail) console.log(serverLog.split('\n').slice(-15).join('\n'));
console.log(`\n${fail ? '\x1b[31m' : '\x1b[32m'}${pass} passed, ${fail} failed\x1b[0m`);
process.exit(fail ? 1 : 0);
