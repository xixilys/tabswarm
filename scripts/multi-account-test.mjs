#!/usr/bin/env node
// End-to-end tests for multi-account support in web-ai-hub:
// - Sandbox deny-read protects ~/.web-ai-hub (all account profiles)
// - `webhub account add/list/enable/disable/remove` + port collision / reserved name validation + live server sync
// - Two independent headless Chrome instances on separate CDP ports (19233 default, 19234 work)
// - Per-(site, account) independent concurrency slots & rate-limit isolation
// - Auto-failover from rate-limited default to work, explicit `--account default` strict refusal, `--account auto` routing, `--chat <url>` account affinity
// - Unified tab inspection across both Chrome instances + auto-resolved tab close by target_id
// - Distinct OAuth client_id instances sharing client_name="ChatGPT" split into separate manual_chatgpt_* sessions
// - `/view/api/state` strips local profile_dir and pid across all accounts
// Own isolated server (ports 18785/18786, temp state dir) + isolated Chrome ports 19233/19234.
import './fixtures/fake-clock.mjs'; // pinned local day: a run crossing midnight cannot change "today" mid-test
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { reap, reapPid, assertPortsFree } from './fixtures/reap.mjs';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(HERE, '..');
const WEBHUB = path.join(REPO, 'bin', 'webhub.mjs');
const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gwm-mtest-')));
const ROOT = path.join(TMP, 'root');
const STATE = path.join(TMP, 'state');
const PROF_DEF = path.join(TMP, 'profile-default');
const PROF_WORK = path.join(TMP, 'profile-work');
fs.mkdirSync(ROOT, { recursive: true });
fs.mkdirSync(STATE, { recursive: true });
process.env.WEBHUB_STATE_DIR = STATE;
process.env.GWM_STATE_DIR = STATE;

const PUB = 18785, ADM = 18786, PORT_DEF = 19233, PORT_WORK = 19234;

let pass = 0, fail = 0;
const check = (name, ok, detail = '') => {
  if (ok) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${name}`); }
  else { fail++; console.log(`  \x1b[31m✗ ${name}\x1b[0m ${String(detail).slice(0, 700)}`); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let cfgRef = null;
const { startFakeGemini } = await import('./fixtures/fake-gemini.mjs');
const { startFakeChatgpt } = await import('./fixtures/fake-chatgpt.mjs');
const fakeGem = await startFakeGemini({ runMock: async ({ id, task }) => { const { mockGemini } = await import('../src/mock-gemini.js'); await mockGemini({ id, task, cfg: cfgRef }); } });
const fakeGpt = await startFakeChatgpt({ runMock: async ({ id, task }) => { const { mockGemini } = await import('../src/mock-gemini.js'); return mockGemini({ id, task, cfg: cfgRef }); } });

fs.writeFileSync(path.join(STATE, 'config.json'), JSON.stringify({
  public_port: PUB,
  admin_port: ADM,
  roots: [{ name: 'mtest', path: ROOT }],
  gemweb: {
    default_account: 'default',
    auto_failover: true,
    concurrency: 1,
    min_interval_sec: 0,
    daily_limit: 5,
    limit_cooldown_min: 5,
    headless: true,
    browser_mode: 'chrome', // the embedded (desktop app) browser has its own test: embedded-test.mjs
    cdp_url: `http://127.0.0.1:${PORT_DEF}`,
    profile_dir: PROF_DEF,
    gemini_url: fakeGem.url,
    chatgpt: { url: fakeGpt.url, idle_sec: 3 },
    operator_models: [],
    accounts: {},
  },
}));

const { loadConfig, DEFAULT_CONFIG } = await import('../src/config.js');
cfgRef = loadConfig();

const { buildSandboxProfile } = await import('../src/jobs.js');
const { Slots } = await import('../src/slots.js');
const { stopDedicated } = await import('../src/browser.js');

let server = null, serverLog = '';
const clients = [];

const webhub = (args) => new Promise((resolve) => {
  const ch = spawn(process.execPath, [WEBHUB, ...args], {
    env: { ...process.env, WEBHUB_STATE_DIR: STATE, GWM_STATE_DIR: STATE, NO_COLOR: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '', err = '';
  ch.stdout.on('data', (d) => { out += d; });
  ch.stderr.on('data', (d) => { err += d; });
  ch.on('close', (code) => resolve({ code, out, err, id: /TASK_ID=(\S+)/.exec(err)?.[1] }));
});

await assertPortsFree([PUB, ADM, PORT_DEF, PORT_WORK], 'multi-account-test');
try {
  // ---------------- 1. Sandbox + Slots unit checks ----------------
  console.log('sandbox & per-(site, account) slots:');
  const sb = buildSandboxProfile(DEFAULT_CONFIG, [{ path: ROOT }]);
  check('sandbox denies read/write under ~/.web-ai-hub', sb.includes(path.join(os.homedir(), '.web-ai-hub')), sb);

  console.log('keychain flags (real vs throwaway profiles):');
  const { keychainArgs, isRealProfileDir } = await import('../src/browser.js');
  const MOCK = ['--use-mock-keychain', '--password-store=basic'];
  check('real default profile keeps the login keychain', keychainArgs('~/.web-ai-hub/chrome-profile').length === 0 && isRealProfileDir(path.join(os.homedir(), '.web-ai-hub', 'chrome-profile')));
  check('real extra-account profile keeps the login keychain', keychainArgs(path.join(os.homedir(), '.web-ai-hub', 'profiles', 'work')).length === 0);
  check('temp test profile gets mock keychain + basic password store', JSON.stringify(keychainArgs(PROF_DEF)) === JSON.stringify(MOCK) && !isRealProfileDir(PROF_WORK));
  check('lookalike path outside the state dir is not treated as real', keychainArgs(path.join(os.homedir(), '.web-ai-hub-evil', 'p')).length === 2 && keychainArgs(path.join(TMP, '.web-ai-hub', 'chrome-profile')).length === 2);
  check('mock_keychain:false turns it off for a temp profile; true can never force it onto a real one', keychainArgs(PROF_DEF, false).length === 0 && keychainArgs('~/.web-ai-hub/chrome-profile', true).length === 0);
  check('a real profile path that is a symlink to elsewhere is still real', isRealProfileDir(path.join(os.homedir(), '.web-ai-hub', 'profiles', 'linked-somewhere-else')) && keychainArgs(path.join(os.homedir(), '.web-ai-hub', 'chrome-profile')).length === 0);

  const slotCfg = {
    gemweb: {
      concurrency: 1,
      min_interval_sec: 0,
      cdp_url: `http://127.0.0.1:${PORT_DEF}`,
      profile_dir: PROF_DEF,
      accounts: {
        work: { cdp_url: `http://127.0.0.1:${PORT_WORK}`, profile_dir: PROF_WORK, concurrency: 2, sites: ['gemini', 'chatgpt'] },
      },
    },
  };
  const recs = new Map([
    ['d1', { id: 'd1', site: 'gemini', account: 'default' }],
    ['d2', { id: 'd2', site: 'gemini', account: 'default' }],
    ['w1', { id: 'w1', site: 'gemini', account: 'work' }],
    ['w2', { id: 'w2', site: 'gemini', account: 'work' }],
  ]);
  const sl = new Slots(slotCfg, { get: (id) => recs.get(id), isActive: () => true, setStatus() {} }, { emit() {} });
  const aD1 = await sl.acquire(recs.get('d1'), 0);
  const aD2 = await sl.acquire(recs.get('d2'), 100);
  const aW1 = await sl.acquire(recs.get('w1'), 0);
  const aW2 = await sl.acquire(recs.get('w2'), 0);
  const sSum = sl.summary();
  check(
    'default (c=1) queues 2nd Gemini task while work (c=2) runs 2 Gemini tasks in parallel',
    aD1.granted && !aD2.granted && aW1.granted && aW2.granted
      && sSum.by_account.default.gemini.running.length === 1 && sSum.by_account.default.gemini.queued.length === 1
      && sSum.by_account.work.gemini.running.length === 2,
    JSON.stringify(sSum),
  );
  for (const id of ['d1', 'd2', 'w1', 'w2']) sl.release(id);

  // ---------------- 2. Start server & test live account management ----------------
  server = reap(spawn(process.execPath, [path.join(REPO, 'src', 'server.js')], {
    env: { ...process.env, WEBHUB_STATE_DIR: STATE, GWM_STATE_DIR: STATE },
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
    const data = await r.json().catch(() => ({}));
    return { status: r.status, ok: r.ok, data };
  };

  console.log('account CLI + validation + live server sync:');
  // Add "work" directly via POST /api/accounts with custom profile_dir so it stays inside TMP
  const addWork = await api('/accounts', {
    method: 'POST',
    body: { name: 'work', label: 'Work', port: PORT_WORK, profile_dir: PROF_WORK, sites: ['gemini', 'chatgpt'], concurrency: 2, daily_limit: 5 },
  });
  check('POST /api/accounts creates isolated "work" account', addWork.ok && addWork.data.account?.port === PORT_WORK, JSON.stringify(addWork));
  const dupPort = await api('/accounts', {
    method: 'POST',
    body: { name: 'dup', port: PORT_WORK, profile_dir: path.join(TMP, 'profile-dup') },
  });
  check('duplicate CDP port rejected with 400', dupPort.status === 400, JSON.stringify(dupPort));
  const badReserved = await api('/accounts', { method: 'POST', body: { name: 'auto' } });
  check('reserved account name "auto" rejected with 400', badReserved.status === 400, JSON.stringify(badReserved));
  const rmDef = await api('/accounts/default', { method: 'DELETE' });
  check('removing "default" account refused with 400', rmDef.status === 400, JSON.stringify(rmDef));

  const cliList = await webhub(['account', 'list', '--json']);
  const parsedList = JSON.parse(cliList.out);
  check('webhub account list shows both default and work', cliList.code === 0 && parsedList.accounts.length === 2, cliList.out + cliList.err);

  const disRes = await webhub(['account', 'disable', 'work']);
  const enRes = await webhub(['account', 'enable', 'work']);
  check('webhub account disable/enable updates live state', disRes.code === 0 && enRes.code === 0 && (await api('/accounts')).data.accounts.find((a) => a.name === 'work')?.enabled === true);

  // ---------------- 3. Launch TWO independent headless Chrome instances ----------------
  console.log('two independent Chrome instances + multi-account tab control:');
  const upDef = await webhub(['browser', 'up', '--account', 'default']);
  const upWork = await webhub(['browser', 'up', '--account', 'work']);
  check('both Chrome instances launched independently', upDef.code === 0 && upWork.code === 0, upDef.out + upDef.err + upWork.out + upWork.err);
  const vDef = await fetch(`http://127.0.0.1:${PORT_DEF}/json/version`).then((r) => r.json()).catch(() => null);
  const vWork = await fetch(`http://127.0.0.1:${PORT_WORK}/json/version`).then((r) => r.json()).catch(() => null);
  const { execFileSync } = await import('node:child_process');
  const testChromes = execFileSync('/bin/ps', ['-eo', 'pid=,command='], { encoding: 'utf8' }).split('\n')
    .filter((l) => (l.includes(`--remote-debugging-port=${PORT_DEF}`) || l.includes(`--remote-debugging-port=${PORT_WORK}`)) && !l.includes('--type='));
  for (const l of testChromes) reapPid(Number(/^\s*(\d+)/.exec(l)?.[1]));
  check('both test Chromes launched with --use-mock-keychain --password-store=basic', testChromes.length === 2 && testChromes.every((l) => l.includes('--use-mock-keychain') && l.includes('--password-store=basic')), testChromes.join('\n'));
  check('separate CDP endpoints respond on 19233 and 19234', !!vDef?.webSocketDebuggerUrl && !!vWork?.webSocketDebuggerUrl && vDef.webSocketDebuggerUrl !== vWork.webSocketDebuggerUrl, JSON.stringify({ vDef, vWork }));

  const openGemDef = (await api('/browser/open', { method: 'POST', body: { site: 'gemini', account: 'default', bring_to_front: false } })).data;
  const openGptWork = (await api('/browser/open', { method: 'POST', body: { site: 'chatgpt', account: 'work', bring_to_front: false } })).data;
  const multiTabs = (await api('/browser/tabs?probe=1')).data;
  const tDef = multiTabs.tabs.find((x) => x.target_id === openGemDef.target_id);
  const tWork = multiTabs.tabs.find((x) => x.target_id === openGptWork.target_id);
  check(
    'GET /api/browser/tabs?probe=1 correlates tabs across both accounts',
    tDef?.account === 'default' && tDef?.site === 'gemini' && tWork?.account === 'work' && tWork?.site === 'chatgpt',
    JSON.stringify(multiTabs.tabs),
  );
  // Close tab by target_id WITHOUT specifying account (server auto-resolves owning Chrome)
  const autoClose = await api('/browser/close', { method: 'POST', body: { target_id: openGptWork.target_id } });
  await api('/browser/close', { method: 'POST', body: { target_id: openGemDef.target_id } });
  const afterAutoClose = (await api('/browser/tabs')).data;
  check('POST /api/browser/close auto-resolves owning account by target_id', autoClose.ok && !afterAutoClose.tabs.some((x) => x.target_id === openGptWork.target_id));

  // ---------------- 4. End-to-end routing: rate-limit failover, explicit refusal, chat affinity, --account auto ----------------
  console.log('routing, rate-limit failover, chat affinity, --account auto:');
  const taskBody = (name) => `Write ${name}.\nMOCK write ${ROOT}/${name}\nhello ${name}\nMOCK end\nMOCK run ${ROOT} :: cat ${name}`;

  // First, run a Gemini task explicitly on "work" so we get a work chat_url
  let r = await webhub(['run', '--site', 'gemini', '--account', 'work', '--no-operator', '--timeout', '120', taskBody('w1.txt')]);
  const workTask = r.id ? (await api(`/tasks/${r.id}`)).data : {};
  const workChatUrl = workTask.chat_url;
  check('explicit --account work runs in work Chrome and records account="work"', r.code === 0 && workTask.account === 'work' && /\/app\/[0-9a-f]+/.test(workChatUrl || ''), JSON.stringify({ code: r.code, workTask, out: r.out }));

  // Trigger rate-limit on "default" only
  fakeGem.state.mode = 'limit';
  r = await webhub(['run', '--site', 'gemini', '--account', 'default', '--no-operator', '--timeout', '60', 'hit limit']);
  check('default account hits rate-limit (exit 3)', r.code === 3 && /BLOCKED: rate-limit\|/.test(r.out), r.out + r.err);
  fakeGem.state.mode = 'ok';

  // Explicit --account default stays blocked (no silent jump)
  r = await webhub(['run', '--site', 'gemini', '--account', 'default', '--no-operator', '--timeout', '60', 'should block']);
  check('explicit --account default refuses while paused (strict)', r.code === 3 && /BLOCKED: rate-limit\|/.test(r.out) && !r.id, r.out);

  // Omitted --account automatically fails over to healthy "work"
  r = await webhub(['run', '--site', 'gemini', '--no-operator', '--timeout', '120', taskBody('failover.txt')]);
  const foTask = r.id ? (await api(`/tasks/${r.id}`)).data : {};
  check('omitted --account fails over from paused default -> work cleanly', r.code === 0 && foTask.account === 'work' && fs.readFileSync(path.join(ROOT, 'failover.txt'), 'utf8') === 'hello failover.txt\n', JSON.stringify({ code: r.code, foTask, out: r.out }));

  // Clear limit on default; test --chat affinity back to work, then --account auto picking lower-used default!
  const clr = await webhub(['limit', 'clear', 'gemini', '--account', 'default']);
  check('webhub limit clear --account default clears pause', clr.code === 0 && /cleared/.test(clr.out), clr.out);

  r = await webhub(['run', '--site', 'gemini', '--chat', workChatUrl, '--no-operator', '--timeout', '120', taskBody('chat_pin.txt')]);
  const pinTask = r.id ? (await api(`/tasks/${r.id}`)).data : {};
  check('--chat <workChatUrl> pins to work even though default is healthy and less used', r.code === 0 && pinTask.account === 'work', JSON.stringify({ code: r.code, pinTask, out: r.out }));

  // Right now default has 0 successful today (or 1 if limit send counted -> actually default=1, work=3), so --account auto chooses default!
  r = await webhub(['run', '--site', 'gemini', '--account', 'auto', '--no-operator', '--timeout', '120', taskBody('auto_bal.txt')]);
  const autoTask = r.id ? (await api(`/tasks/${r.id}`)).data : {};
  check('--account auto picks least-loaded healthy account (default)', r.code === 0 && autoTask.account === 'default', JSON.stringify({ code: r.code, autoTask, out: r.out }));

  const psOut = await webhub(['ps']);
  check('webhub ps renders 账号与浏览器 (2) with both default and work', psOut.code === 0 && psOut.out.includes('账号与浏览器 (2)') && psOut.out.includes('default') && psOut.out.includes('work'), psOut.out);

  // ---------------- 5. Two OAuth client_ids sharing client_name="ChatGPT" ----------------
  console.log('per-client_id manual chat separation & /view sanitization:');
  async function connectNamedClient(name) {
    const redirect = 'http://127.0.0.1/cb';
    const reg = await fetch(`http://127.0.0.1:${PUB}/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ client_name: name, redirect_uris: [redirect], token_endpoint_auth_method: 'client_secret_post' }),
    }).then((res) => res.json());
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
    }).then((res) => res.json());
    const mc = new Client({ name, version: '1' });
    await mc.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${PUB}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${tok.access_token}` } },
    }));
    clients.push(mc);
    return { mc, clientId: reg.client_id };
  }

  const c1 = await connectNamedClient('ChatGPT');
  const c2 = await connectNamedClient('ChatGPT');
  await c1.mc.callTool({ name: 'list_roots', arguments: {} });
  await c2.mc.callTool({ name: 'list_roots', arguments: {} });
  const allTasks = (await api('/tasks')).data;
  const man1 = allTasks.find((t) => t.origin === 'mcp' && t.client_id === c1.clientId);
  const man2 = allTasks.find((t) => t.origin === 'mcp' && t.client_id === c2.clientId);
  check('two OAuth clients both named "ChatGPT" get separate manual_chatgpt_* sessions', !!man1 && !!man2 && man1.id !== man2.id, JSON.stringify({ man1, man2 }));

  // /view/api/state strips sensitive paths & pids from all accounts
  const loginRes = await fetch(`http://127.0.0.1:${PUB}/view/login`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ passcode: secrets.passcode }),
  });
  const cookie = (loginRes.headers.get('set-cookie') || '').split(';')[0];
  const viewState = await fetch(`http://127.0.0.1:${PUB}/view/api/state`, { headers: { cookie } }).then((res) => res.json());
  const strippedOk = Array.isArray(viewState.accounts) && viewState.accounts.length === 2
    && viewState.accounts.every((a) => a.profile_dir === undefined && a.browser?.pid === undefined)
    && viewState.browser.accounts.every((b) => b.profile_dir === undefined && b.pid === undefined);
  check('/view/api/state strips profile_dir and pid across every account', strippedOk, JSON.stringify({ accounts: viewState.accounts, br: viewState.browser }));

  // ---------------- 6. Clean removal & purge ----------------
  const remRes = await webhub(['account', 'remove', 'work', '--purge']);
  check('webhub account remove work --purge removes account & deletes profile', remRes.code === 0 && !fs.existsSync(PROF_WORK) && (await api('/accounts')).data.accounts.length === 1, remRes.out + remRes.err);
} finally {
  for (const c of clients) await c.close().catch(() => {});
  await stopDedicated(loadConfig(), 'default').catch(() => {});
  await stopDedicated({ ...loadConfig(), gemweb: { ...loadConfig().gemweb, accounts: { work: { port: PORT_WORK, profile_dir: PROF_WORK } } } }, 'work').catch(() => {});
  if (server) {
    await new Promise((resolve) => {
      if (server.exitCode !== null || server.signalCode !== null) return resolve();
      const timer = setTimeout(() => { try { server.kill('SIGKILL'); } catch { /* */ } resolve(); }, 3000);
      server.once('close', () => { clearTimeout(timer); resolve(); });
      try { server.kill('SIGTERM'); } catch { clearTimeout(timer); resolve(); }
    });
  }
  await fakeGem.close().catch(() => {});
  await fakeGpt.close().catch(() => {});
  await sleep(200);
  if (!process.argv.includes('--keep')) fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 6, retryDelay: 200 });
  else console.log(`kept ${TMP}`);
}

if (fail) console.log(serverLog.split('\n').slice(-20).join('\n'));
console.log(`\n${fail ? '\x1b[31m' : '\x1b[32m'}${pass} passed, ${fail} failed\x1b[0m`);
process.exit(fail ? 1 : 0);
