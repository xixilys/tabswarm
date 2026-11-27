#!/usr/bin/env node
// Regression tests for the Chrome-window sign-in (`webhub browser login-external`, src/login-external.js)
// that copies a session into the embedded browser. No Electron: a mock of the app's control API stands in.
// Real headless Chrome (own temp profile, mock keychain) is used for the sign-in window.
// Ports: sign-in Chrome 19338, mock control API 19341. Temp state dir.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { reap, assertPortsFree } from './fixtures/reap.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(HERE, '..');
const WEBHUB = path.join(REPO, 'bin', 'webhub.mjs');
const LOGIN = 19338, CTL = 19341, FAKE_CDP = 19340;
const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gwm-ltest-')));
const STATE = path.join(TMP, 'state'), LOGIN_ROOT = path.join(TMP, 'login');
fs.mkdirSync(path.join(STATE, 'run'), { recursive: true });
process.env.WEBHUB_STATE_DIR = STATE; process.env.GWM_STATE_DIR = STATE;
await assertPortsFree([LOGIN, CTL, FAKE_CDP, 19342, 19343, 19349], 'login-test');

let pass = 0, fail = 0;
const check = (name, ok, detail = '') => { if (ok) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${name}`); } else { fail++; console.log(`  \x1b[31m✗ ${name}\x1b[0m ${String(detail).slice(0, 900)}`); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

fs.writeFileSync(path.join(STATE, 'config.json'), JSON.stringify({
  public_port: 19343, admin_port: 19342, // never the real hub's ports
  gemweb: { embedded: { login_port: LOGIN, cdp_port: FAKE_CDP, control_port: CTL, login_profile_root: LOGIN_ROOT }, accounts: { work: { port: 19349, profile_dir: path.join(TMP, 'pw') }, geminionly: { port: 19350, profile_dir: path.join(TMP, 'pg'), sites: ['gemini'] } } },
}));
fs.writeFileSync(path.join(STATE, 'secrets.json'), JSON.stringify({ admin_token: 'tok' }));

// ---- mock of the app's control API ----
const mock = { mode: 'ok', posts: [], purges: [], partition: [], barriers: 0, pending: Promise.resolve(), lockAtBarrier: null, barrierFail: false };
const ctlSrv = http.createServer(async (req, res) => {
  const body = await new Promise((r) => { let b = ''; req.on('data', (c) => { b += c; }); req.on('end', () => r(b ? JSON.parse(b) : {})); });
  const send = (o) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: true, ...o })); };
  if (req.method === 'POST' && req.url === '/cookies') {
    if (mock.mode === 'http500') { res.writeHead(500, { 'content-type': 'application/json' }); return res.end('{"ok":false}'); }
    mock.posts.push(body);
    if (mock.mode === 'slow') { // answers long after the client gave up, but still imports
      const done = new Promise((r2) => setTimeout(() => { mock.partition = body.cookies.map((c) => ({ name: c.name, domain: c.domain })); r2(); }, 1500));
      mock.pending = mock.pending.then(() => done);
      await done; return send({ imported: body.cookies.length, failed: 0 });
    }
    if (mock.mode === 'fail-import') return send({ imported: 0, failed: body.cookies.length });
    if (mock.mode === 'partial') return send({ imported: body.cookies.length - 1, failed: 1, failed_names: [body.cookies.find((c) => c.name.startsWith('__Secure-next-auth')).name] });
    mock.partition = mock.mode === 'lost' ? [] : mock.mode === 'drop-tail' ? body.cookies.slice(0, -1).map((c) => ({ name: c.name, domain: c.domain })) : body.cookies.map((c) => ({ name: c.name, domain: c.domain }));
    return send({ imported: body.cookies.length, failed: 0 });
  }
  if (req.method === 'GET' && req.url.startsWith('/cookies/')) return send({ cookies: mock.partition });
  if (req.method === 'POST' && req.url === '/barrier') {
    mock.barriers++; mock.lockAtBarrier = lockFiles().length;
    if (mock.barrierFail) { res.writeHead(500, { 'content-type': 'application/json' }); return res.end('{"ok":false}'); }
    await mock.pending; return send({});
  }
  if (req.method === 'POST' && req.url === '/purge') { mock.purges.push(body.account); if (mock.mode === 'purge-fail') { res.writeHead(500, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ ok: false, error: 'boom' })); } return send({ cleared: true }); }
  if (req.method === 'POST' && req.url === '/cookies' && mock.mode === 'http500') { res.writeHead(500); return res.end('{}'); }
  res.writeHead(404); res.end('{}');
});
await new Promise((r) => ctlSrv.listen(CTL, '127.0.0.1', r));
fs.writeFileSync(path.join(STATE, 'run', 'embedded.json'), JSON.stringify({ pid: process.pid, cdp_url: `http://127.0.0.1:${FAKE_CDP}`, control_url: `http://127.0.0.1:${CTL}` }));

const runCli = (args, env = {}) => {
  const ch = reap(spawn(process.execPath, [WEBHUB, ...args], { env: { ...process.env, WEBHUB_LOGIN_SPAWN_DIRECT: '1', WEBHUB_LOGIN_HEADLESS: '1', WEBHUB_LOGIN_SETTLE_MS: '300', NO_COLOR: '1', ...env }, stdio: ['ignore', 'pipe', 'pipe'] }));
  const r = { out: '', ch, done: null };
  ch.stdout.on('data', (d) => { r.out += d; }); ch.stderr.on('data', (d) => { r.out += d; });
  r.done = new Promise((res) => ch.on('close', (code) => res(code)));
  return r;
};
const loginUp = () => fetch(`http://127.0.0.1:${LOGIN}/json/version`).then((x) => x.ok).catch(() => false);
const waitLogin = async () => { for (let i = 0; i < 120; i++) { if (await loginUp()) return true; await sleep(150); } return false; };
const { chromium } = await import('playwright-core');
const setCookies = async (cookies) => {
  const b = await chromium.connectOverCDP(`http://127.0.0.1:${LOGIN}`);
  const s = await b.newBrowserCDPSession();
  await s.send('Storage.setCookies', { cookies: cookies.map((c) => ({ secure: true, path: '/', expires: Math.floor(Date.now() / 1000) + 3600, ...c })) });
  await b.close().catch(() => {});
};
const gptCookie = (v = 'sess', name = '__Secure-next-auth.session-token') => ({ name, value: v, domain: '.chatgpt.com', httpOnly: true });
const lockOf = (pid) => path.join(STATE, 'run', `login-${LOGIN}.${pid}.lock`);
const lockFile = lockOf(process.pid); // a live "other" owner for the tests (this process)
const noLocks = () => lockFiles().length === 0;
const lockFiles = () => { try { return fs.readdirSync(path.join(STATE, 'run')).filter((n) => new RegExp(`^login-${LOGIN}\\.\\d+\\.lock$`).test(n)); } catch { return []; } };
const A = ['browser', 'login-external', 'chatgpt', '--url', 'about:blank'];

try {
  const lx = await import('../src/login-external.js');
  const acc = await import('../src/accounts.js');
  const { loadConfig } = await import('../src/config.js');
  const cfg = loadConfig();

  console.log('what counts as signed in:');
  check('empty session token is not a session', !lx.signedInCookies('chatgpt', [{ name: '__Secure-next-auth.session-token', value: '', domain: '.chatgpt.com' }]) && !lx.signedInCookies('gemini', [{ name: '__Secure-1PSID', value: '', domain: '.google.com' }]));
  check('chunked token must be complete (no gap, no empty chunk); names-only lists still count', !lx.signedInCookies('chatgpt', [{ name: '__Secure-next-auth.session-token.1', value: 'b', domain: 'chatgpt.com' }]) && !lx.signedInCookies('chatgpt', [{ name: '__Secure-next-auth.session-token.0', value: 'a', domain: 'chatgpt.com' }, { name: '__Secure-next-auth.session-token.2', value: 'c', domain: 'chatgpt.com' }]) && lx.signedInCookies('chatgpt', [{ name: '__Secure-next-auth.session-token.0', value: 'a', domain: 'chatgpt.com' }, { name: '__Secure-next-auth.session-token.1', value: 'b', domain: 'chatgpt.com' }]) && lx.signedInCookies('chatgpt', [{ name: '__Secure-next-auth.session-token.0', domain: 'chatgpt.com' }]));
  check('login hint always names the account (the default dispatch account can differ from "default")', lx.loginExternalHint('chatgpt', 'default') === 'webhub browser login-external chatgpt --account default' && lx.loginExternalHint('gemini', 'work') === 'webhub browser login-external gemini --account work');
  check('sign-in port and app ports are reserved from account port allocation', acc.nextFreePort({ gemweb: { accounts: {} } }) === 9231 && ![9238, 9240, 9241].includes(acc.nextFreePort({ gemweb: { accounts: Object.fromEntries([9231, 9232, 9233, 9234, 9235, 9236, 9237].map((p, i) => [`a${i}`, { port: p }])) } })));
  check('profile dir cannot escape the sign-in root', (() => { try { lx.loginProfileDir(cfg, '../evil'); return false; } catch { return true; } })() && lx.loginProfileDir(cfg, 'Work') === path.join(LOGIN_ROOT, 'work'));

  console.log('account validation before anything starts:');
  let r = runCli([...A, '--account', 'ghost']); let code = await r.done;
  check('unknown account is refused (exit 2), no profile created', code === 2 && /unknown account/.test(r.out) && !fs.existsSync(path.join(LOGIN_ROOT, 'ghost')), `${code} ${r.out}`);
  r = runCli([...A, '--account', '../evil']); code = await r.done;
  check('path-like account is refused (exit 2) and nothing is created outside the root', code === 2 && !fs.existsSync(path.join(TMP, 'evil')), `${code} ${r.out}`);
  r = runCli(['browser', 'login-external', 'chatgpt', '--account', 'geminionly']); code = await r.done;
  check('a site the account is not set up for is refused (exit 2)', code === 2 && /not set up for chatgpt/.test(r.out), `${code} ${r.out}`);

  console.log('shared port is never trusted (stale marker / other account / other browser):');
  fs.mkdirSync(path.join(LOGIN_ROOT, 'default'), { recursive: true });
  fs.writeFileSync(path.join(LOGIN_ROOT, 'default', '.webhub-login-port'), String(LOGIN)); // leftover from an old sign-in
  const seen = [];
  const fakeCdp = http.createServer((req, res) => { seen.push(`${req.method} ${req.url}`); res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ Browser: 'Other/1', webSocketDebuggerUrl: `ws://127.0.0.1:${LOGIN}/x` })); });
  await new Promise((rs) => fakeCdp.listen(LOGIN, '127.0.0.1', rs));
  r = runCli([...A, '--account', 'default']); code = await r.done;
  check('someone else\'s browser on the port is not reused even with a stale marker (exit 2, only a version probe sent)', code === 2 && /in use by another browser/.test(r.out) && seen.every((x) => x === 'GET /json/version'), `${code} ${r.out} ${seen}`);
  await new Promise((rs) => fakeCdp.close(rs));
  check('a failed attempt leaves no lock behind', noLocks());
  fs.writeFileSync(lockFile, JSON.stringify({ pid: process.pid, account: 'work', site: 'chatgpt' })); // a live sign-in of another account
  r = runCli([...A, '--account', 'default']); code = await r.done;
  check('a second sign-in while one is running is refused (exit 2) and leaves the first one\'s lock', code === 2 && /another sign-in is in progress/.test(r.out) && fs.existsSync(lockFile), `${code} ${r.out}`);
  fs.unlinkSync(lockFile);
  fs.writeFileSync(lockOf(2147483000), JSON.stringify({ pid: 2147483000, account: 'work', site: 'chatgpt' })); // owner died

  console.log('lock protocol / identity checks:');
  const LK = path.join(REPO, 'src', 'login-external.js');
  const stress = `
    import fs from 'node:fs';
    const { acquireLoginLock } = await import(${JSON.stringify(LK)});
    const { loadConfig } = await import(${JSON.stringify(path.join(REPO, 'src', 'config.js'))});
    const cfg = loadConfig(); const HOLD = ${JSON.stringify(path.join(TMP, 'holder'))};
    let got = 0, bad = 0;
    for (let i = 0; i < 25; i++) {
      let rel; try { rel = await acquireLoginLock(cfg, { account: 'x', site: 'chatgpt' }); } catch { await new Promise((r) => setTimeout(r, 15)); continue; }
      if (fs.existsSync(HOLD)) bad++;                       // somebody else is inside
      fs.writeFileSync(HOLD, String(process.pid));
      await new Promise((r) => setTimeout(r, 25));
      if (fs.readFileSync(HOLD, 'utf8') !== String(process.pid)) bad++; // somebody overwrote ours
      fs.unlinkSync(HOLD); got++; rel();
    }
    console.log(JSON.stringify({ got, bad }));`;
  const workers = Array.from({ length: 8 }, () => { const c = reap(spawn(process.execPath, ['--input-type=module', '-e', stress], { env: process.env, stdio: ['ignore', 'pipe', 'pipe'] })); let out = ''; c.stdout.on('data', (d) => { out += d; }); c.stderr.on('data', (d) => { out += d; }); return new Promise((res) => c.on('close', () => res(out))); });
  const outs = (await Promise.all(workers)).map((o) => { try { return JSON.parse(o.trim().split('\n').pop()); } catch { return { got: 0, bad: 99, raw: o }; } });
  check('eight processes hammering the lock: never two inside at once, and the lock does get used', outs.every((o) => o.bad === 0) && outs.reduce((a, o) => a + o.got, 0) >= 8 && noLocks(), JSON.stringify(outs));
  check('Chrome identity: exact profile match only (a longer path, a helper process, a different profile do not match)', lx.commandHasProfile('/x/Chrome --user-data-dir=/p/work --no-first-run', '/p/work') && lx.commandHasProfile('/x/Chrome --a --user-data-dir=/p/work', '/p/work') && !lx.commandHasProfile('/x/Chrome --user-data-dir=/p/work-other --a', '/p/work') && !lx.commandHasProfile('/x/Chrome --type=renderer --user-data-dir=/p/work', '/p/work') && !lx.commandHasProfile('/x/Chrome --user-data-dir=/p/other', '/p/work'));
  check('Chrome identity: a "-backup" single-dash tail, a repeated switch, and a path continuing after a space do not match', !lx.commandHasProfile('/x/C --user-data-dir=/p/work -backup --a', '/p/work') && !lx.commandHasProfile('/x/C --user-data-dir=/p/work --user-data-dir=/q', '/p/work') && !lx.commandHasProfile('/x/C --user-data-dir=/q --user-data-dir=/p/work', '/p/work') && lx.commandHasProfile('/x/C --user-data-dir=/p/work --no-first-run', '/p/work'));
  // a failed publish (disk error) must not leave this process "holding" the port
  const realWrite = fs.writeFileSync; let boom = true;
  fs.writeFileSync = (...a) => { if (boom && String(a[0]).includes('.lock.') ) { boom = false; throw new Error('disk full'); } return realWrite(...a); };
  const first = await lx.acquireLoginLock(cfg, { account: 'a' }).then(() => 'ok', (e) => e.message);
  fs.writeFileSync = realWrite;
  const again = await lx.acquireLoginLock(cfg, { account: 'a' }).then((rel) => { rel(); return 'ok'; }, (e) => e.message);
  check('after an I/O error while publishing the lock, the same process can take it again', first === 'disk full' && again === 'ok' && noLocks(), `${first} / ${again}`);
  const CB = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  check('Chrome identity: the open launcher, a look-alike switch, and "<dir> backup" are not our Chrome; the real binary is', !lx.commandHasProfile('/usr/bin/open -n -a X --args --user-data-dir=/p/work', '/p/work', CB) && !lx.commandHasProfile(`${CB} --label=--user-data-dir=/p/work`, '/p/work', CB) && !lx.commandHasProfile(`${CB} --user-data-dir=/p/work backup --x`, '/p/work', CB) && lx.commandHasProfile(`${CB} --remote-debugging-port=1 --user-data-dir=/p/work --no-first-run about:blank`, '/p/work', CB) && lx.commandHasProfile(`${CB} --user-data-dir=/p/work https://chatgpt.com/auth/login`, '/p/work', CB));
  const inProc = await lx.acquireLoginLock(cfg, { account: 'a', site: 'chatgpt' });
  check('inside one process (the app server) a second holder is refused too, and release is idempotent', await lx.acquireLoginLock(cfg, { account: 'b', purge: true }).then(() => false, (e) => e.status === 409) && (inProc(), inProc(), noLocks()));
  fs.writeFileSync(lockOf(process.ppid), JSON.stringify({ pid: process.ppid, account: 'work', site: 'chatgpt' })); // a waiting contender's marker
  fs.mkdirSync(path.join(LOGIN_ROOT, 'work'), { recursive: true });
  const heldPurge = await lx.purgeAccountLogin(cfg, 'work', { locked: true });
  check('a purge that already holds the lock is not blocked by a contender\'s marker', heldPurge.profile === true && !fs.existsSync(path.join(LOGIN_ROOT, 'work')), JSON.stringify(heldPurge));
  fs.unlinkSync(lockOf(process.ppid));
  const foreign = http.createServer((q, a) => a.end('{}')); await new Promise((rs) => foreign.listen(LOGIN, '127.0.0.1', rs));
  check('a listener that is not our Chrome (or nothing at all) is never accepted — fails closed', lx.chromeOwnsPort(LOGIN, path.join(LOGIN_ROOT, 'default')) === false && lx.chromeOwnsPort(19399, path.join(LOGIN_ROOT, 'default')) === false);
  await new Promise((rs) => foreign.close(rs));
  console.log('config.json read-modify-write under contention:');
  const CSTATE = path.join(TMP, 'cfgstate'); fs.mkdirSync(CSTATE, { recursive: true });
  fs.writeFileSync(path.join(CSTATE, 'config.json'), JSON.stringify({ gemweb: { accounts: {} } }));
  const acctScript = `
    const { upsertAccountInConfig, setDefaultAccountInConfig, setAccountEnabledInConfig } = await import(${JSON.stringify(path.join(REPO, 'src', 'accounts.js'))});
    const { loadConfig } = await import(${JSON.stringify(path.join(REPO, 'src', 'config.js'))});
    const cfg = loadConfig(); const i = Number(process.argv.at(-1));
    for (let k = 0; k < 6; k++) {
      upsertAccountInConfig(cfg, 'c' + i + 'x' + k, { port: 19500 + i * 10 + k });
      if (k === 3) setAccountEnabledInConfig(cfg, 'c' + i + 'x0', false);
      if (k === 4) setDefaultAccountInConfig(cfg, 'c' + i + 'x1');
    }`;
  const cw = Array.from({ length: 6 }, (_, i) => { const c = reap(spawn(process.execPath, ['--input-type=module', '-e', acctScript, String(i)], { env: { ...process.env, WEBHUB_STATE_DIR: CSTATE, GWM_STATE_DIR: CSTATE }, stdio: ['ignore', 'pipe', 'pipe'] })); let o = ''; c.stdout.on('data', (d) => { o += d; }); c.stderr.on('data', (d) => { o += d; }); return new Promise((res) => c.on('close', (cd) => res({ cd, o }))); });
  const cres = await Promise.all(cw);
  const saved = JSON.parse(fs.readFileSync(path.join(CSTATE, 'config.json'), 'utf8')).gemweb.accounts;
  const names = Object.keys(saved);
  check('six processes adding/toggling/defaulting accounts at once: no update is lost (36 accounts, all toggles kept), no lock files left', cres.every((x) => x.cd === 0) && names.length === 36 && Array.from({ length: 6 }, (_, i) => saved[`c${i}x0`]?.enabled === false).every(Boolean) && !fs.readdirSync(CSTATE).some((n) => /cfglock/.test(n)), JSON.stringify({ codes: cres.map((x) => x.cd + x.o.slice(0, 120)), n: names.length }));
  console.log('lock under real contention, pre-startup signal:');
  fs.rmSync(path.join(LOGIN_ROOT, 'default'), { recursive: true, force: true });
  const racers = Array.from({ length: 6 }, () => runCli([...A, '--account', 'default', '--timeout', '8']));
  const codes = await Promise.all(racers.map((x) => x.done));
  const started = racers.filter((x) => /opening a Chrome sign-in window/.test(x.out)).length;
  check('six simultaneous sign-ins: never more than one starts Chrome, the others are refused (exit 2)', started <= 1 && codes.filter((c) => c === 2).length === 6 - started && codes.filter((c) => c === 3).length === started, `${codes} started=${started} ${racers.find((x) => /opening a Chrome/.test(x.out))?.out}`);
  check('nothing is left running or locked afterwards', !(await loginUp()) && noLocks());
  r = runCli([...A, '--account', 'default', '--timeout', '60']);
  for (let i = 0; i < 100 && !/opening a Chrome/.test(r.out); i++) await sleep(20);
  r.ch.kill('SIGTERM'); await r.done;
  for (let i = 0; i < 80 && (await loginUp() || !noLocks()); i++) await sleep(250);
  check('SIGTERM right after launch (before Chrome is up) still ends with no Chrome and no lock', !(await loginUp()) && noLocks());
  console.log('timeout / cancel cleanup:');
  r = runCli(['browser', 'login-external', '--url', 'about:blank', '--timeout', '3', '--account', 'default'], {}); // no <site>: gemini, --timeout parsed as an option
  code = await r.done;
  check('no site + --timeout parses (exit 3 after the timeout, not a usage error); dead owner\'s lock was taken over', code === 3 && /not signed in to gemini within 3s/.test(r.out), `${code} ${r.out}`);
  check('the sign-in Chrome is closed after a timeout, lock released', !(await loginUp()) && noLocks());
  r = runCli([...A, '--account', 'default', '--timeout', '60']);
  await waitLogin(); r.ch.kill('SIGTERM'); await r.done;
  for (let i = 0; i < 40 && await loginUp(); i++) await sleep(250);
  check('SIGTERM (app quit / exec timeout) closes the sign-in Chrome and releases the lock', !(await loginUp()) && noLocks());

  console.log('import must really have worked:');
  mock.mode = 'fail-import'; mock.posts.length = 0;
  r = runCli([...A, '--account', 'default', '--timeout', '30']); await waitLogin(); await setCookies([gptCookie()]);
  code = await r.done;
  check('all cookie writes failed → exit 4, not "signed in"; Chrome closed', code === 4 && !/signed in: copied/.test(r.out) && !(await loginUp()), `${code} ${r.out}`);
  mock.mode = 'lost';
  r = runCli([...A, '--account', 'default', '--timeout', '30']); await waitLogin(); await setCookies([gptCookie()]);
  code = await r.done;
  check('writes reported ok but the session cookie is not in the partition → exit 4', code === 4 && /did not make it/.test(r.out), `${code} ${r.out}`);
  mock.mode = 'http500';
  fs.rmSync(path.join(LOGIN_ROOT, 'default'), { recursive: true, force: true });
  r = runCli([...A, '--account', 'default', '--timeout', '30']); await waitLogin(); await setCookies([gptCookie('a')]);
  code = await r.done;
  check('the app answering the import with an HTTP error → exit 4 (import failure), not a generic 1', code === 4 && /refused the cookies/.test(r.out), `${code} ${r.out}`);
  mock.mode = 'slow'; mock.posts.length = 0; mock.partition = [];
  fs.rmSync(path.join(LOGIN_ROOT, 'default'), { recursive: true, force: true });
  r = runCli([...A, '--account', 'default', '--timeout', '30'], { WEBHUB_COOKIE_POST_TIMEOUT_MS: '300' }); await waitLogin(); await setCookies([gptCookie('a')]);
  code = await r.done;
  check('import slower than the client timeout: the CLI waits for the app to finish (barrier) while still holding the lock, then judges by the partition → exit 0', code === 0 && mock.barriers === 1 && mock.lockAtBarrier >= 1 && mock.partition.some((c) => c.name.startsWith('__Secure-next-auth')) && noLocks(), `${code} barriers=${mock.barriers} lock=${mock.lockAtBarrier} ${r.out}`);
  mock.barriers = 0; mock.barrierFail = true; mock.partition = [];
  fs.rmSync(path.join(LOGIN_ROOT, 'default'), { recursive: true, force: true });
  r = runCli([...A, '--account', 'default', '--timeout', '30'], { WEBHUB_COOKIE_POST_TIMEOUT_MS: '300' }); await waitLogin(); await setCookies([gptCookie('a')]);
  code = await r.done; mock.barrierFail = false;
  check('timeout and the app cannot confirm it stopped importing → exit 4 "state unknown" (fails closed, lock released afterwards)', code === 4 && /state is unknown/.test(r.out) && noLocks(), `${code} ${r.out}`);
  await mock.pending;
  mock.mode = 'partial';
  fs.rmSync(path.join(LOGIN_ROOT, 'default'), { recursive: true, force: true });
  r = runCli([...A, '--account', 'default', '--timeout', '30']); await waitLogin(); await setCookies([gptCookie('a'), { name: 'ordinary', value: 'x', domain: '.chatgpt.com' }]);
  code = await r.done;
  check('the session cookie failed to write while others succeeded → exit 4', code === 4 && /could not be written/.test(r.out), `${code} ${r.out}`);
  mock.mode = 'drop-tail';
  fs.rmSync(path.join(LOGIN_ROOT, 'default'), { recursive: true, force: true });
  r = runCli([...A, '--account', 'default', '--timeout', '30']); await waitLogin(); await setCookies([gptCookie('a', '__Secure-next-auth.session-token.0'), gptCookie('b', '__Secure-next-auth.session-token.1')]);
  code = await r.done;
  check('a token chunk missing in the partition (tail chunk lost) → exit 4 even though the others landed', code === 4 && /did not make it/.test(r.out), `${code} ${r.out}`);
  mock.mode = 'ok'; mock.posts.length = 0;
  fs.rmSync(path.join(LOGIN_ROOT, 'default'), { recursive: true, force: true }); // the kept profile still holds the earlier test's cookie
  r = runCli([...A, '--account', 'default', '--timeout', '30']); await waitLogin(); await setCookies([gptCookie('')]);
  await sleep(4000);
  check('an empty session token does not finish the sign-in (still waiting, nothing posted)', r.ch.exitCode === null && mock.posts.length === 0, r.out);
  await setCookies([gptCookie('real')]);
  code = await r.done;
  check('a real token later completes it (exit 0)', code === 0 && mock.posts.length === 1, `${code} ${r.out}`);
  mock.posts.length = 0;
  r = runCli([...A, '--account', 'WORK', '--timeout', '30']); await waitLogin(); await setCookies([gptCookie(), { name: 'etest-google', value: 'g', domain: '.google.com' }]);
  code = await r.done;
  check('account name is normalised (WORK → work), only the site\'s cookies are copied, profile under the sign-in root', code === 0 && mock.posts[0]?.account === 'work' && mock.posts[0].cookies.every((c) => /chatgpt|openai/.test(c.domain)) && fs.existsSync(path.join(LOGIN_ROOT, 'work')), `${code} ${r.out} ${JSON.stringify(mock.posts)}`);

  console.log('import-login only reads the account\'s own Chrome:');
  const notChrome = http.createServer((q, a2) => { a2.writeHead(200, { 'content-type': 'application/json' }); a2.end(JSON.stringify({ Browser: 'Chrome/1', webSocketDebuggerUrl: 'ws://127.0.0.1:19349/x' })); });
  await new Promise((rs) => notChrome.listen(19349, '127.0.0.1', rs)); // what account "work" is configured to use, held by something that is not its Chrome
  mock.posts.length = 0;
  r = runCli(['browser', 'import-login', 'chatgpt', '--account', 'work']); code = await r.done;
  check('a listener on the account\'s port that is not its own Chrome is refused (exit 2), nothing read or written', code === 2 && /is not the dedicated Chrome/.test(r.out) && mock.posts.length === 0, `${code} ${r.out}`);
  await new Promise((rs) => notChrome.close(rs));
  // a remote CDP endpoint cannot be proven to be the local Chrome, even if the same port is ours locally
  const cfgPath = path.join(STATE, 'config.json'); const cfgText = fs.readFileSync(cfgPath, 'utf8');
  const cj = JSON.parse(cfgText); cj.gemweb.accounts.work.cdp_url = 'http://192.0.2.7:19349'; fs.writeFileSync(cfgPath, JSON.stringify(cj));
  mock.posts.length = 0;
  r = runCli(['browser', 'import-login', 'chatgpt', '--account', 'work']); code = await r.done;
  check('a non-loopback CDP address is refused for import-login (exit 2, nothing read or written)', code === 2 && /not a local \(loopback\)/.test(r.out) && mock.posts.length === 0, `${code} ${r.out}`);
  fs.writeFileSync(cfgPath, cfgText);
  fs.writeFileSync(lockOf(process.ppid), JSON.stringify({ pid: process.ppid, account: 'work', site: 'chatgpt' })); // a sign-in / import-login is running
  const cfgBefore = fs.readFileSync(path.join(STATE, 'config.json'), 'utf8');
  r = runCli(['account', 'add', 'work', '--port', '19360']); code = await r.done;
  check('re-binding an account is refused while a sign-in / import-login holds the lock, config untouched', code !== 0 && /in progress/.test(r.out) && fs.readFileSync(path.join(STATE, 'config.json'), 'utf8') === cfgBefore, `${code} ${r.out}`);
  r = runCli(['account', 'remove', 'work']); code = await r.done;
  check('a plain `account remove` (no --purge) is refused while a sign-in holds the lock, config untouched', code !== 0 && /in progress/.test(r.out) && fs.readFileSync(path.join(STATE, 'config.json'), 'utf8') === cfgBefore, `${code} ${r.out}`);
  fs.unlinkSync(lockOf(process.ppid));
  console.log('account remove --purge:');
  check('an account port cannot be one of the app\'s reserved ports', await Promise.all([LOGIN, FAKE_CDP, CTL].map((p) => { try { acc.upsertAccountInConfig(cfg, 'portly', { port: p }); return false; } catch { return true; } })).then((x) => x.every(Boolean)));
  check('--account without a value, or --account= (empty), is an error, not a silent fallback', await (async () => { const a1 = await runCli(['browser', 'login-external', 'chatgpt', '--account']).done; const a2 = await runCli(['browser', 'login-external', 'chatgpt', '--account=']).done; return a1 === 2 && a2 === 2; })());
  fs.mkdirSync(path.join(LOGIN_ROOT, 'work'), { recursive: true });
  const pr = await lx.purgeAccountLogin(cfg, 'work');
  check('purge removes the sign-in profile and asks the app to clear the partition', !fs.existsSync(path.join(LOGIN_ROOT, 'work')) && mock.purges.includes('work') && pr.partition === true, JSON.stringify({ pr, purges: mock.purges }));
  fs.writeFileSync(lockOf(process.ppid), JSON.stringify({ pid: process.ppid, account: 'work', site: 'chatgpt' })); // another live process
  check('purge is refused while that account is signing in', await lx.purgeAccountLogin(cfg, 'work').then(() => false, (e) => e.status === 409));
  r = runCli(['account', 'remove', 'work', '--purge']); code = await r.done;
  check('`webhub account remove --purge` is refused while that account signs in, and the account stays', code !== 0 && /in progress/.test(r.out) && JSON.parse(fs.readFileSync(path.join(STATE, 'config.json'), 'utf8')).gemweb.accounts.work, `${code} ${r.out}`);
  fs.unlinkSync(lockOf(process.ppid));
  fs.mkdirSync(path.join(LOGIN_ROOT, 'work'), { recursive: true });
  fs.rmSync(path.join(STATE, 'run', 'embedded.json'));
  r = runCli(['account', 'remove', 'work', '--purge']); await r.done;
  check('purge with the app not running says so instead of claiming everything was cleared', /NOT cleared \(the Web AI Hub app is not running/.test(r.out) && !fs.existsSync(path.join(LOGIN_ROOT, 'work')), r.out);

  mock.mode = 'purge-fail'; fs.writeFileSync(path.join(STATE, 'run', 'embedded.json'), JSON.stringify({ pid: process.pid, cdp_url: `http://127.0.0.1:${FAKE_CDP}`, control_url: `http://127.0.0.1:${CTL}` }));
  const pf = await lx.purgeAccountLogin(cfg, 'work');
  check('the app failing to clear the partition is reported (partition=false, error), never assumed', pf.partition === false && /boom|500/.test(pf.error || ''), JSON.stringify(pf));
  mock.mode = 'ok';
  console.log('account bar shows the browser actually in use:');
  const topSrc = fs.readFileSync(path.join(REPO, 'bin', 'webhub.mjs'), 'utf8');
  const srvSrc = fs.readFileSync(path.join(REPO, 'src', 'server.js'), 'utf8');
  check('webhub top / API use the running browser\'s port and label the embedded app', /b\.mode === 'embedded' \? 'App内嵌'/.test(topSrc) && /port: br\.port \?\? a\.port/.test(srvSrc));
} finally {
  for (const f of [lockFile, lockOf(process.ppid), lockOf(2147483000)]) { try { fs.unlinkSync(f); } catch { /* none */ } }
  if (await loginUp()) { try { const b = await chromium.connectOverCDP(`http://127.0.0.1:${LOGIN}`); await (await b.newBrowserCDPSession()).send('Browser.close').catch(() => {}); } catch { /* ignore */ } }
  ctlSrv.close();
  { try { fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch (e) { console.log(`cleanup: ${e.message}`); } }
}
console.log(`\n${fail ? '\x1b[31m' : '\x1b[32m'}${pass} passed, ${fail} failed\x1b[0m`);
process.exit(fail ? 1 : 0);
