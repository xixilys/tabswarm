#!/usr/bin/env node
// End-to-end test of the embedded browser (Web AI Hub desktop app, gemweb.browser_mode "embedded"):
// - the Electron app advertises CDP + control API in STATE_DIR/run/embedded.json; the control API
//   needs the admin token and refuses cross-origin calls
// - pages are created by the app (Electron's CDP cannot create targets) in one persistent
//   partition per account (cookies isolated between accounts), with a plain Chrome user agent
// - pages keep running at full speed while the window is hidden (no background throttling)
// - a ChatGPT task (fake ChatGPT page + mock model) runs end to end inside the embedded browser,
//   its tab is closed afterwards and the task records driver.host = "embedded"
// - cookie import into an account partition (what `webhub browser import-login` uses)
// Own server (ports 18789/18790, temp state dir) + its own Electron instance (CDP 19240, control
// 19241, temp userData, mock keychain). Skips (exit 0) when desktop/node_modules has no Electron.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { reap, assertPortsFree } from './fixtures/reap.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(HERE, '..');
const DESKTOP = path.join(REPO, 'desktop');
const WEBHUB = path.join(REPO, 'bin', 'webhub.mjs');
let ELECTRON = null;
try { ELECTRON = createRequire(path.join(DESKTOP, 'package.json'))('electron'); } catch { /* not installed */ }
if (!ELECTRON || !fs.existsSync(ELECTRON)) {
  console.log('embedded-test: skipped (Electron not installed: cd desktop && npm install)');
  process.exit(0);
}

const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gwm-etest-')));
const ROOT = path.join(TMP, 'root'), STATE = path.join(TMP, 'state');
for (const d of [ROOT, STATE]) fs.mkdirSync(d, { recursive: true });
process.env.WEBHUB_STATE_DIR = STATE; process.env.GWM_STATE_DIR = STATE;
const PUB = 18789, ADM = 18790, EMB_CDP = 19240, EMB_CTL = 19241, LOGIN_CDP = 19238;
await assertPortsFree([PUB, ADM, EMB_CDP, EMB_CTL, LOGIN_CDP], 'embedded-test');

let pass = 0, fail = 0;
const check = (name, ok, detail = '') => { if (ok) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${name}`); } else { fail++; console.log(`  \x1b[31m✗ ${name}\x1b[0m ${String(detail).slice(0, 900)}`); } };
const chromium_ = async () => (await import('playwright-core')).chromium;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let cfgRef = null;
const { startFakeChatgpt } = await import('./fixtures/fake-chatgpt.mjs');
const fake = await startFakeChatgpt({ runMock: async ({ id, task }) => { const { mockGemini } = await import('../src/mock-gemini.js'); return mockGemini({ id, task, cfg: cfgRef }); } });
fs.writeFileSync(path.join(STATE, 'config.json'), JSON.stringify({
  public_port: PUB, admin_port: ADM, roots: [{ name: 'etest', path: ROOT }],
  gemweb: {
    concurrency: 2, min_interval_sec: 0, daily_limit: 5, operator_models: [],
    browser_mode: 'embedded',
    embedded: { cdp_port: EMB_CDP, control_port: EMB_CTL, fallback_to_chrome: false, login_port: LOGIN_CDP, login_profile_root: path.join(TMP, 'login') },
    chatgpt: { url: fake.url, idle_sec: 3 },
    accounts: { work: { port: 19249, profile_dir: path.join(TMP, 'profile-work') } },
  },
}));
const { loadConfig } = await import('../src/config.js');
cfgRef = loadConfig();

let server = null, app = null, appLog = '', serverLog = '';
try {
  server = reap(spawn(process.execPath, [path.join(REPO, 'src', 'server.js')], { env: process.env, stdio: ['ignore', 'pipe', 'pipe'] }));
  server.stdout.on('data', (d) => { serverLog += d; }); server.stderr.on('data', (d) => { serverLog += d; });
  for (let i = 0; i < 50; i++) { if (await fetch(`http://127.0.0.1:${ADM}/api/state`).then((r) => r.ok).catch(() => false)) break; await sleep(200); }
  const token = JSON.parse(fs.readFileSync(path.join(STATE, 'secrets.json'), 'utf8')).admin_token;

  // stand-in for `webhub`: records the external sign-in the app asks for
  const STUB = path.join(TMP, 'webhub-stub.mjs'), CALLS = path.join(TMP, 'login-calls.txt');
  fs.writeFileSync(STUB, ['#!/usr/bin/env node', "import fs from 'node:fs';", `fs.appendFileSync(${JSON.stringify(CALLS)}, process.argv.slice(2).join(' ') + '\\n');`, 'setTimeout(() => process.exit(0), 300);', ''].join('\n'), { mode: 0o755 });
  app = reap(spawn(ELECTRON, [DESKTOP, '--use-mock-keychain', '--password-store=basic'], {
    env: { ...process.env, WEBHUB_DESKTOP_HEADLESS: '1', WEBHUB_DESKTOP_USER_DATA: path.join(TMP, 'electron'), WEBHUB_DESKTOP_WEBHUB_BIN: STUB, WEBHUB_DESKTOP_SITE_URLS: JSON.stringify({ gemini: `${fake.url}?site=gemini`, chatgpt: fake.url }) },
    stdio: ['ignore', 'pipe', 'pipe'],
  }));
  app.stdout.on('data', (d) => { appLog += d; }); app.stderr.on('data', (d) => { appLog += d; });

  console.log('desktop app advertises the embedded browser:');
  const infoPath = path.join(STATE, 'run', 'embedded.json');
  let info = null;
  for (let i = 0; i < 100 && !info; i++) { try { info = JSON.parse(fs.readFileSync(infoPath, 'utf8')); } catch { await sleep(200); } }
  check('run/embedded.json written with CDP and control URLs', info?.cdp_url === `http://127.0.0.1:${EMB_CDP}` && info?.control_url === `http://127.0.0.1:${EMB_CTL}` && info.pid === app.pid, JSON.stringify(info) + '\n' + appLog);
  const ctl = (p, o = {}) => fetch(`http://127.0.0.1:${EMB_CTL}${p}`, { method: o.method || 'GET', headers: { ...(o.noAuth ? {} : { authorization: `Bearer ${token}` }), ...(o.origin ? { origin: o.origin } : {}), ...(o.body ? { 'content-type': 'application/json' } : {}) }, body: o.body ? JSON.stringify(o.body) : undefined }).then(async (r) => ({ status: r.status, data: await r.json().catch(() => ({})) }));
  check('control API refuses calls without the admin token (401)', (await ctl('/health', { noAuth: true })).status === 401);
  check('control API refuses cross-origin calls even with the token (403)', (await ctl('/tabs', { origin: 'https://evil.example' })).status === 403);
  check('health ok with the token', (await ctl('/health')).data.ok === true);
  const ps = execFileSync('/bin/ps', ['-eo', 'pid=,command='], { encoding: 'utf8' }).split('\n').find((l) => new RegExp(`^\\s*${app.pid}\\s`).test(l)) || '';
  check('test Electron runs with --use-mock-keychain --password-store=basic', ps.includes('--use-mock-keychain') && ps.includes('--password-store=basic'), ps);

  console.log('tabs, partitions, user agent, background running:');
  const { chromium } = await import('playwright-core');
  const browser = await chromium.connectOverCDP(info.cdp_url, { timeout: 15000 });
  const ctx = browser.contexts()[0];
  const { listTabs, embeddedApi } = await import('../src/browser.js');
  const pageOf = async (tid) => { for (let i = 0; i < 80; i++) { for (const p of ctx.pages()) { const s = await ctx.newCDPSession(p).catch(() => null); if (!s) continue; const id = (await s.send('Target.getTargetInfo').catch(() => null))?.targetInfo?.targetId; await s.detach().catch(() => {}); if (id === tid) return p; } await sleep(100); } return null; };
  const tA = (await ctl('/tabs', { method: 'POST', body: { account: 'default', url: fake.url } })).data.tab;
  const tB = (await ctl('/tabs', { method: 'POST', body: { account: 'work', url: fake.url } })).data.tab;
  check('app creates tabs with CDP target ids, one partition per account', !!tA?.target_id && !!tB?.target_id && tA.partition === 'persist:webhub-default' && tB.partition === 'persist:webhub-work', JSON.stringify({ tA, tB }));
  const pA = await pageOf(tA.target_id), pB = await pageOf(tB.target_id);
  check('driver can attach to app-created tabs over CDP', !!pA && !!pB);
  await pA.waitForLoadState('domcontentloaded').catch(() => {}); await pB.waitForLoadState('domcontentloaded').catch(() => {});
  await pA.evaluate(() => { document.cookie = 'etest=default-only; path=/; max-age=600'; });
  check('cookies are isolated between account partitions', (await pA.evaluate(() => document.cookie)).includes('etest=default-only') && !(await pB.evaluate(() => document.cookie)).includes('etest'));
  const ua = await pA.evaluate(() => navigator.userAgent);
  check('pages present a plain Chrome user agent (no "Electron/")', /Chrome\/\d+/.test(ua) && !/Electron|web-ai-hub/i.test(ua), ua);
  const ticks = await pA.evaluate(() => new Promise((res) => { let n = 0; const t = setInterval(() => n++, 50); setTimeout(() => { clearInterval(t); res(n); }, 2000); }));
  check('a tab in the hidden window keeps timers at full speed (≥25 of 40 ticks in 2 s)', ticks >= 25, `ticks=${ticks}`);
  const tC = (await ctl('/tabs', { method: 'POST', body: { account: 'default', url: `${fake.url}?keep=1` } })).data.tab;
  console.log('Google sign-in never loads inside the app (goes to a Chrome window instead):');
  await pA.evaluate(() => { location.href = 'https://accounts.google.com/ServiceLogin?continue=https%3A%2F%2Fgemini.google.com%2Fapp'; }).catch(() => {});
  let calls = '';
  for (let i = 0; i < 40 && !calls; i++) { await sleep(150); calls = fs.existsSync(CALLS) ? fs.readFileSync(CALLS, 'utf8') : ''; }
  check('navigating to accounts.google.com asks for `webhub browser login-external chatgpt --account default` (site follows the tab)', /^browser login-external chatgpt --account default$/m.test(calls), calls + appLog.slice(-800));
  await sleep(800);
  const urlA = (await ctl('/tabs')).data.tabs.find((x) => x.id === tA.id)?.url || '';
  check('the tab never shows Google\'s sign-in page (reloaded with the site afterwards)', !/accounts\.google\.com/.test(urlA) && urlA.startsWith(fake.url), urlA);
  check('other pages are left alone after a sign-in (only the tab that asked is reloaded)', ((await ctl('/tabs')).data.tabs.find((x) => x.id === tC.id)?.url || '').includes('keep=1'), JSON.stringify((await ctl('/tabs')).data.tabs.map((x) => x.url)));
  await pB.evaluate((u) => { window.open(u, '_blank', 'popup'); }, 'https://accounts.google.com/o/oauth2/v2/auth?client_id=x');
  await sleep(1200);
  calls = fs.readFileSync(CALLS, 'utf8');
  check('a Google sign-in popup (ChatGPT "Continue with Google") is not opened in the app either', /browser login-external chatgpt --account work/.test(calls) && (await ctl('/tabs')).data.tabs.length === 3, calls);
  // an allowed relay popup (auth.openai.com) that redirects to Google is stopped as well
  fs.writeFileSync(CALLS, '');
  await sleep(800);
  const winsBefore = (await ctl('/state')).data.tabs.length;
  await pB.evaluate((u) => { window.open(u, '_blank', 'popup'); }, `${fake.url}oauth-popup`);
  let calls2 = '';
  for (let i = 0; i < 40 && !calls2; i++) { await sleep(150); calls2 = fs.readFileSync(CALLS, 'utf8'); }
  check('a relay popup that redirects to Google is stopped too (guard on popup windows)', /^browser login-external chatgpt --account work$/m.test(calls2) && (await ctl('/state')).data.tabs.length === winsBefore, calls2 + appLog.slice(-500));
  // a background task tab must not start a sign-in (it would break the dedicated-Chrome fallback)
  fs.writeFileSync(CALLS, '');
  await sleep(800);
  const tT = (await ctl('/tabs', { method: 'POST', body: { account: 'default', url: 'about:blank', kind: 'task' } })).data.tab;
  const pT = await pageOf(tT.target_id);
  await pT.goto(`${fake.url}to-google`, { timeout: 4000 }).catch(() => {});
  await sleep(1000);
  check('a task tab redirected to Google sign-in starts no Chrome sign-in and shows no notice', (fs.readFileSync(CALLS, 'utf8') === '') && !/Chrome/.test((await ctl('/state')).data.notice || ''), fs.readFileSync(CALLS, 'utf8') + JSON.stringify((await ctl('/state')).data.notice));
  await ctl(`/tabs/${tT.id}/close`, { method: 'POST' });
  await ctl(`/tabs/${tC.id}/close`, { method: 'POST' });
  const stNotice = (await ctl('/state')).data;
  check('the tab bar tells the user what happened', /登录/.test(stNotice.notice || ''), JSON.stringify(stNotice.notice));
  const work = await listTabs(cfgRef, 'work');
  check('listTabs(account) only returns that account\'s tabs', work.length === 1 && work[0].id === tB.target_id, JSON.stringify(work));
  await ctl(`/tabs/${tB.id}/close`, { method: 'POST' });
  const { closeTab } = await import('../src/browser.js');
  check('closeTab by target id (account resolved from the app)', await closeTab(cfgRef, tA.target_id) === true);
  await sleep(300);
  check('both tabs gone', (await ctl('/tabs')).data.tabs.length === 0, JSON.stringify((await ctl('/tabs')).data));

  console.log('cookie import into an account partition:');
  const imp = await embeddedApi(info, 'POST', '/cookies', { account: 'work', cookies: [{ name: '__Secure-etest', value: 'v', domain: '.chatgpt.com', path: '/', secure: true, httpOnly: true, sameSite: 'Lax', expires: Math.floor(Date.now() / 1000) + 3600 }] });
  const names = (await ctl('/cookies/work')).data.cookies || [];
  check('imported cookie lands in persist:webhub-work only (names listed, values never returned)', imp.imported === 1 && names.some((c) => c.name === '__Secure-etest' && c.domain === '.chatgpt.com') && !JSON.stringify(names).includes('"value"') && !((await ctl('/cookies/default')).data.cookies || []).some((c) => c.name === '__Secure-etest'), JSON.stringify({ imp, names }));
  // an import still running when a purge arrives: the purge waits for it, so nothing is left behind
  const many = Array.from({ length: 150 }, (_, i) => ({ name: `bulk${i}`, value: 'v', domain: '.chatgpt.com', path: '/', secure: true, expires: Math.floor(Date.now() / 1000) + 3600 }));
  const impP = ctl('/cookies', { method: 'POST', body: { account: 'work', cookies: many } });
  const purP = ctl('/purge', { method: 'POST', body: { account: 'work' } });
  const [impR, purR] = await Promise.all([impP, purP]);
  const leftAfter = ((await ctl('/cookies/work')).data.cookies || []).length;
  check('a purge that arrives during an import waits for it and leaves the partition empty', impR.status === 200 && purR.status === 200 && purR.data.cleared === true && leftAfter === 0, JSON.stringify({ imp: impR.status, pur: purR.data, leftAfter }));
  // the CLI gives up on an import (client timeout) while the app is still writing: the barrier waits for the app to finish
  const many2 = Array.from({ length: 150 }, (_, i) => ({ name: `late${i}`, value: 'v', domain: '.chatgpt.com', path: '/', secure: true, expires: Math.floor(Date.now() / 1000) + 3600 }));
  const aborted = await fetch(`http://127.0.0.1:${EMB_CTL}/cookies`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ account: 'work', cookies: many2 }), signal: AbortSignal.timeout(2) }).then(() => 'answered', (e) => e.name);
  const bar = await ctl('/barrier', { method: 'POST', body: { account: 'work' } });
  const lateCount = ((await ctl('/cookies/work')).data.cookies || []).filter((c) => c.name.startsWith('late')).length;
  check('after the client gave up on an import, /barrier returns only once the app finished it (all 150 cookies present, nothing still being written)', ['TimeoutError', 'AbortError'].includes(aborted) && bar.status === 200 && lateCount === 150, JSON.stringify({ aborted, bar: bar.status, lateCount }));
  await ctl('/purge', { method: 'POST', body: { account: 'work' } });
  await browser.close().catch(() => {});

  console.log('sign-in in a Chrome window, session copied into the account partition:');
  const { signedInCookies, siteCookies } = await import('../src/login-external.js');
  check('signed-in detection: Google needs __Secure-1PSID on google.com, ChatGPT its session token', signedInCookies('gemini', [{ name: '__Secure-1PSID', domain: '.google.com' }]) && !signedInCookies('gemini', [{ name: 'NID', domain: '.google.com' }]) && signedInCookies('chatgpt', [{ name: '__Secure-next-auth.session-token.0', domain: 'chatgpt.com' }]) && siteCookies('chatgpt', [{ name: 'a', domain: '.google.com' }]).length === 0);
  const lg = reap(spawn(process.execPath, [WEBHUB, 'browser', 'login-external', 'chatgpt', '--account', 'work', '--url', 'about:blank', '--timeout', '60'], { env: { ...process.env, WEBHUB_LOGIN_SPAWN_DIRECT: '1', WEBHUB_LOGIN_HEADLESS: '1', NO_COLOR: '1' }, stdio: ['ignore', 'pipe', 'pipe'] }));
  let lgOut = ''; lg.stdout.on('data', (d) => { lgOut += d; }); lg.stderr.on('data', (d) => { lgOut += d; });
  const lgDone = new Promise((r) => lg.on('close', r));
  let lcdp = null;
  for (let i = 0; i < 100 && !lcdp; i++) { lcdp = await fetch(`http://127.0.0.1:${LOGIN_CDP}/json/version`).then((x) => x.json()).catch(() => null); if (!lcdp) await sleep(150); }
  const lps = execFileSync('/bin/ps', ['-eo', 'command='], { encoding: 'utf8' }).split('\n').find((l) => l.includes(`--remote-debugging-port=${LOGIN_CDP}`) && !l.includes('--type=')) || '';
  check('sign-in Chrome starts with its own profile (temp profile → mock keychain)', !!lcdp && lps.includes(path.join(TMP, 'login', 'work')) && lps.includes('--use-mock-keychain'), lps + lgOut);
  const lb = await chromium.connectOverCDP(`http://127.0.0.1:${LOGIN_CDP}`);
  const lbs = await lb.newBrowserCDPSession();
  await lbs.send('Storage.setCookies', { cookies: [
    { name: '__Secure-next-auth.session-token', value: 'etest-session', domain: '.chatgpt.com', path: '/', secure: true, httpOnly: true, expires: Math.floor(Date.now() / 1000) + 3600 },
    { name: 'etest-google', value: 'g', domain: '.google.com', path: '/', secure: true, expires: Math.floor(Date.now() / 1000) + 3600 },
  ] });
  await lb.close().catch(() => {});
  const lgCode = await Promise.race([lgDone, sleep(40000).then(() => 'timeout')]);
  const wc = ((await ctl('/cookies/work')).data.cookies || []).map((c) => c.name);
  check('login-external copies only the site\'s cookies into persist:webhub-work and exits 0', lgCode === 0 && wc.includes('__Secure-next-auth.session-token') && !wc.includes('etest-google'), `code ${lgCode} ${lgOut} ${JSON.stringify(wc)}`);
  check('the sign-in Chrome is closed afterwards', !(await fetch(`http://127.0.0.1:${LOGIN_CDP}/json/version`).then((x) => x.ok).catch(() => false)));

  console.log('ChatGPT task end to end in the embedded browser:');
  const run = (args) => new Promise((resolve) => {
    const ch = spawn(process.execPath, [WEBHUB, ...args], { env: { ...process.env, GEMWEB_FROM: 'etest', NO_COLOR: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = ''; ch.stdout.on('data', (d) => { out += d; }); ch.stderr.on('data', (d) => { err += d; });
    ch.on('close', (code) => resolve({ code, out, err, id: /TASK_ID=(\S+)/.exec(err)?.[1] }));
  });
  const r = await run(['run', '--site', 'chatgpt', '--no-operator', '--timeout', '120', `Write one.txt.\nMOCK write ${ROOT}/one.txt\nhello embedded\nMOCK end\nMOCK run ${ROOT} :: cat one.txt`]);
  check('task finishes with the final report (exit 0)', r.code === 0 && /mock run for .* finished/.test(r.out), `code ${r.code}\n${r.out}\n${r.err}\n${appLog.slice(-1500)}`);
  check('driver log says it ran in the embedded browser', /sent via fast path \(embedded browser \[default\]\)/.test(r.err), r.err);
  const adm = (p) => fetch(`http://127.0.0.1:${ADM}/api${p}`, { headers: { authorization: `Bearer ${token}` } }).then((x) => x.json());
  const t = r.id ? await adm(`/tasks/${r.id}`) : {};
  check('task recorded with driver.host = embedded', t.driver?.host === 'embedded' && t.driver?.browser === 'cdp', JSON.stringify(t.driver));
  check('file written through MCP', fs.existsSync(path.join(ROOT, 'one.txt')) && fs.readFileSync(path.join(ROOT, 'one.txt'), 'utf8').includes('hello embedded'));
  await sleep(300);
  check('the task tab was closed in the app', (await ctl('/tabs')).data.tabs.filter((x) => x.kind === 'task').length === 0, JSON.stringify((await ctl('/tabs')).data.tabs));
  const reg = fs.existsSync(path.join(STATE, 'run', 'tabs')) ? fs.readdirSync(path.join(STATE, 'run', 'tabs')) : [];
  check('tab registry cleaned up', reg.length === 0, reg);
  const tabsApi = await adm('/browser/tabs');
  check('dashboard /api/browser/tabs works in embedded mode', Array.isArray(tabsApi.tabs), JSON.stringify(tabsApi).slice(0, 300));

  console.log('webhub browser status / mode:');
  const st = await run(['browser', 'status']);
  check('`webhub browser status` reports the embedded browser', st.code === 0 && /embedded/.test(st.out), st.out + st.err);
} finally {
  // the sign-in Chrome (own process group) must not outlive a failed run
  try { const b = await chromium_().then((c) => c.connectOverCDP(`http://127.0.0.1:${LOGIN_CDP}`, { timeout: 2000 })); await (await b.newBrowserCDPSession()).send('Browser.close').catch(() => {}); } catch { /* not running */ }
  if (app && app.exitCode === null) { app.kill('SIGTERM'); await Promise.race([new Promise((r) => app.once('exit', r)), sleep(5000)]); }
  if (server && server.exitCode === null) server.kill('SIGTERM');
  await fake.close().catch(() => {});
  if (!process.argv.includes('--keep')) fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
console.log(`\n${fail ? '\x1b[31m' : '\x1b[32m'}${pass} passed, ${fail} failed\x1b[0m`);
process.exit(fail ? 1 : 0);
