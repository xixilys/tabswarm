// Sign-in for the embedded browser through a real Google Chrome window.
//
// Google refuses to sign in inside embedded browser frameworks (Electron/CEF): accounts.google.com
// answers "Couldn't sign you in — this browser or app may not be secure". Faking Chrome's identity
// to get past that check is exactly what Google's policy forbids, so the Web AI Hub app does not
// try. Instead the sign-in happens in a normal Chrome window with its own small profile
// (~/.web-ai-hub/embedded-login/<account>, never the dedicated 9230 profile or ~/.web-ai-hub/profiles/*),
// and once the site's session cookie shows up there, the site's cookies are copied into the
// account's embedded partition (persist:webhub-<account>) and that Chrome is closed. The login
// profile is kept so a later re-sign-in usually needs no password.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { expandHome, STATE_DIR } from './config.js';
import { getAccount, validateAccountName, syncConfigFromDisk } from './accounts.js';
import { cdpVersion, chromePathFor, keychainArgs, readEmbeddedInfo, embeddedApi } from './browser.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const EXTERNAL_LOGIN_URLS = {
  gemini: 'https://accounts.google.com/ServiceLogin?continue=https%3A%2F%2Fgemini.google.com%2Fapp&hl=zh-CN',
  chatgpt: 'https://chatgpt.com/auth/login',
};

// Which cookies make up a site's session, and which one proves the user is signed in.
const SITE_COOKIES = {
  gemini: { domain: /(^|\.)google\.com$/, signedIn: (c) => c.name === '__Secure-1PSID' && /(^|\.)google\.com$/.test(String(c.domain || '').replace(/^\./, '')) && hasValue(c) },
  chatgpt: { domain: /(^|\.)(chatgpt\.com|openai\.com)$/, signedIn: (c) => c.name.startsWith('__Secure-next-auth.session-token') && hasValue(c) },
};
// cookie lists from the app's control API carry names only (value undefined): that counts as present
function hasValue(c) { return c.value === undefined || String(c.value).length > 0; }

export function siteCookies(site, cookies) {
  const s = SITE_COOKIES[site];
  return (cookies || []).filter((c) => s.domain.test(String(c.domain || '').replace(/^\./, '')));
}
export function signedInCookies(site, cookies) {
  const mine = siteCookies(site, cookies);
  if (!mine.some(SITE_COOKIES[site].signedIn)) return false;
  if (site === 'chatgpt') {
    // a chunked session token (.0 .1 …) must be complete: no empty chunk, no gap
    const idx = mine.filter((c) => c.name.startsWith('__Secure-next-auth.session-token')).map((c) => ({ n: /\.(\d+)$/.exec(c.name)?.[1], ok: hasValue(c) }));
    if (idx.some((x) => !x.ok)) return false;
    const ns = idx.filter((x) => x.n !== undefined).map((x) => Number(x.n));
    if (ns.length && !ns.every((_, i) => ns.includes(i))) return false;
  }
  return true;
}

// The command a user should run to sign in for this account/site (account flag only when not default).
export function loginExternalHint(site, account) {
  // always explicit: the "default" account and the default dispatch account (gemweb.default_account) can differ
  return `webhub browser login-external ${site} --account ${account || 'default'}`;
}

export function loginPort(cfg) { return Number(cfg?.gemweb?.embedded?.login_port) || 9238; }
export function loginProfileRoot(cfg) {
  return path.resolve(expandHome(cfg?.gemweb?.embedded?.login_profile_root || path.join(os.homedir(), '.web-ai-hub', 'embedded-login')));
}
export function loginProfileDir(cfg, account) {
  const root = loginProfileRoot(cfg);
  const dir = path.resolve(root, validateAccountName(account));
  if (path.dirname(dir) !== root) throw Object.assign(new Error(`bad account name for a sign-in profile: ${account}`), { status: 400 });
  return dir;
}
// ---- one sign-in (or purge) at a time per debugging port ----
// Each process publishes its own file login-<port>.<pid>.lock (written whole to a temp file, then
// renamed into place, so nobody sees a half-written one). After publishing it lists the files: a file
// whose pid is dead is removed (only ever dead processes' files), and if any OTHER live file exists
// this process backs off (removes its own, retries for ~1s, then reports "in progress"). A process
// that published first is always seen by one that publishes later, so two can never both win, and no
// process ever deletes a live owner's file.
function pidAlive(pid) { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } }
const heldHere = new Set(); // ports whose sign-in lock this process holds (the app server is one process serving many requests)
function lockDir() { return path.join(STATE_DIR, 'run'); }
function lockPrefix(cfg) { return `login-${loginPort(cfg)}.`; }
function liveLocks(cfg) {
  const out = [];
  let names = [];
  try { names = fs.readdirSync(lockDir()); } catch (e) { if (e.code === 'ENOENT') return out; throw e; } // unknown state is not "nobody holds it"
  for (const n of names) {
    const m = n.startsWith(lockPrefix(cfg)) && /^login-\d+\.(\d+)\.lock$/.exec(n);
    if (!m) continue;
    const pid = Number(m[1]);
    const file = path.join(lockDir(), n);
    if (!pidAlive(pid)) { try { fs.unlinkSync(file); } catch { /* gone */ } continue; }
    let info = {};
    try { info = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* being replaced */ }
    out.push({ pid, file, ...info });
  }
  return out;
}
export async function acquireLoginLock(cfg, info) {
  fs.mkdirSync(lockDir(), { recursive: true, mode: 0o700 });
  const mine = path.join(lockDir(), `${lockPrefix(cfg)}${process.pid}.lock`);
  const tmp = `${mine}.${Date.now()}.tmp`;
  const port = loginPort(cfg);
  let released = false;
  const release = () => { if (released) return; released = true; heldHere.delete(port); try { fs.unlinkSync(mine); } catch { /* gone */ } };
  let other = null;
  for (let attempt = 0; attempt < 12; attempt++) {
    if (heldHere.has(port)) { other = { pid: process.pid, ...info, site: 'in this process' }; await sleep(60 + Math.floor(Math.random() * 90)); continue; }
    heldHere.add(port);
    try {
      fs.writeFileSync(tmp, JSON.stringify({ pid: process.pid, ...info, at: Date.now() }), { mode: 0o600 });
      fs.renameSync(tmp, mine);
      other = liveLocks(cfg).find((l) => l.pid !== process.pid) || null;
    } catch (e) { try { fs.unlinkSync(tmp); } catch { /* none */ } release(); throw e; } // a failed publish must not leave this process 'holding' the port
    if (!other) return release;
    release(); released = false;
    await sleep(60 + Math.floor(Math.random() * 90));
  }
  throw Object.assign(new Error(`another sign-in is in progress (${other?.site || '?'} [${other?.account || '?'}], pid ${other?.pid}); finish or close it first`), { code: 2, status: 409 });
}
export async function withLoginLock(cfg, info, fn) {
  const release = await acquireLoginLock(cfg, info);
  try { return await fn(); } finally { release(); }
}
export function assertNoActiveLogin(cfg, account) {
  const name = validateAccountName(account);
  const cur = liveLocks(cfg).find((l) => l.pid !== process.pid && (l.account === name || l.purge));
  if (cur) throw Object.assign(new Error(`a sign-in for "${name}" is in progress (pid ${cur.pid}); finish it first`), { status: 409 });
}
// Returns what was actually cleared: { profile, partition, app_running, error? }. partition is true only when
// the app confirmed the account's cookies/storage are empty; false when the app is not running or it failed.
export async function purgeAccountLogin(cfg, account, { locked = false } = {}) {
  if (!locked) return withLoginLock(cfg, { account: validateAccountName(account), purge: true }, () => purgeAccountLogin(cfg, account, { locked: true }));
  const name = validateAccountName(account); // (the caller holds the lock: waiting sign-ins are not owners)
  let profile = true;
  try { fs.rmSync(loginProfileDir(cfg, name), { recursive: true, force: true }); } catch { profile = false; }
  const emb = readEmbeddedInfo();
  let partition = false, error;
  if (emb) {
    try { partition = (await embeddedApi(emb, 'POST', '/purge', { account: name }))?.cleared === true; } catch (e) { error = e.message; }
  }
  return { profile, partition, app_running: !!emb, ...(error ? { error } : {}) };
}

// ---- which Chrome is ours ----
// Our sign-in Chrome is the main (non --type=) process started with exactly `--user-data-dir=<profileDir>`.
export function commandHasProfile(command, profileDir, chromeBin = null) {
  const c = String(command).trim();
  if (/\s--type=/.test(c)) return false;
  // the executable is the Chrome binary itself (not /usr/bin/open or any other program repeating the flag)
  if (chromeBin && !(c === chromeBin || c.startsWith(`${chromeBin} `))) return false;
  if ((c.match(/\s--user-data-dir=/g) || []).length !== 1) return false; // none, or ambiguous (repeated switch)
  const needle = ` --user-data-dir=${profileDir}`;
  const i = c.indexOf(needle);
  if (i < 0) return false;
  const rest = c.slice(i + needle.length);
  // the next thing is the end, another long switch, or the start URL: not a longer path such as "<dir> backup" / "<dir> -x"
  return rest === '' || /^\s+(--[A-Za-z]|https?:|about:)/.test(rest);
}
// pids of our sign-in Chrome (main process) — null when the process table could not be read (unknown, not "none")
function ourChromePids(profileDir, chromeBin = null) {
  try {
    return execFileSync('/bin/ps', ['-axo', 'pid=,command='], { encoding: 'utf8', timeout: 8000, maxBuffer: 16 << 20 })
      .split('\n').map((l) => /^\s*(\d+)\s+(.*)$/.exec(l)).filter((m) => m && commandHasProfile(m[2], profileDir, chromeBin)).map((m) => Number(m[1]));
  } catch { return null; }
}
// true only when something listens on the port AND every listener is our sign-in Chrome (fails closed)
export function chromeOwnsPort(port, profileDir, chromeBin = null) {
  try {
    const ours = new Set(ourChromePids(profileDir, chromeBin) || []);
    if (!ours.size) return false;
    const pids = execFileSync('/usr/sbin/lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'], { encoding: 'utf8', timeout: 8000 }).split(/\s+/).filter(Boolean).map(Number);
    return pids.length > 0 && pids.every((p) => ours.has(p));
  } catch { return false; }
}
// stops exactly the processes started with our profile; true only when none is left (unknown = not done)
async function killOurChrome(profileDir, chromeBin) {
  for (const sig of ['SIGTERM', 'SIGKILL']) {
    let pids = ourChromePids(profileDir, chromeBin);
    for (let i = 0; pids === null && i < 3; i++) { await sleep(500); pids = ourChromePids(profileDir, chromeBin); }
    if (pids === null) return false;
    if (!pids.length) return true;
    for (const pid of pids) { try { process.kill(pid, sig); } catch { /* gone */ } }
    for (let i = 0; i < 20 && (ourChromePids(profileDir, chromeBin) || [1]).length; i++) await sleep(250);
  }
  const left = ourChromePids(profileDir, chromeBin);
  return Array.isArray(left) && left.length === 0;
}

// POST the cookies to the app. If the request times out (or the connection drops) the app may STILL be writing
// them, so we wait for the account's queue in the app to drain before anything else happens (the sign-in lock is
// held until then): { r } when the app answered, { r: null, settled: true } when it finished after we gave up.
// An answer with an HTTP error is a refusal (code 4); a queue that never drains is "state unknown" (code 4).
export async function postCookiesSettled(emb, account, cookies) {
  const timeoutMs = Number(process.env.WEBHUB_COOKIE_POST_TIMEOUT_MS) || 60000;
  try {
    return { r: await embeddedApi(emb, 'POST', '/cookies', { account, cookies }, timeoutMs) };
  } catch (e) {
    if (!(e?.name === 'TimeoutError' || e?.name === 'AbortError' || e?.cause?.code === 'UND_ERR_SOCKET' || e?.cause?.code === 'ECONNRESET')) {
      throw Object.assign(new Error(`the app refused the cookies: ${e.message}`), { code: 4 });
    }
    const drained = await embeddedApi(emb, 'POST', '/barrier', { account }, 120000).then(() => true, () => false);
    if (!drained) throw Object.assign(new Error('the app did not answer in time and did not confirm it stopped importing; the account\'s state is unknown — check it and sign in again'), { code: 4 });
    return { r: null, settled: true };
  }
}

async function browserCookies(cdpUrl) {
  const { chromium } = await import('playwright-core');
  const browser = await chromium.connectOverCDP(cdpUrl, { timeout: 15000 });
  try {
    const bs = await browser.newBrowserCDPSession();
    try { return (await bs.send('Storage.getCookies')).cookies || []; } finally { await bs.detach().catch(() => {}); }
  } finally { await browser.close().catch(() => {}); } // disconnect only
}

async function closeChrome(cdpUrl) {
  const v = await cdpVersion(cdpUrl);
  if (!v?.webSocketDebuggerUrl) return;
  const { chromium } = await import('playwright-core');
  const browser = await chromium.connectOverCDP(cdpUrl, { timeout: 15000 }).catch(() => null);
  if (!browser) return;
  const bs = await browser.newBrowserCDPSession().catch(() => null);
  await bs?.send('Browser.close').catch(() => {}); // graceful: Chrome flushes its cookie store
  await browser.close().catch(() => {});
  for (let i = 0; i < 40 && await cdpVersion(cdpUrl); i++) await sleep(250);
}

// Opens the login Chrome for `account` on `site`, waits until signed in, copies the site's
// cookies into the embedded partition, checks they landed, and closes the login Chrome.
// Always its own Chrome: the shared port is never trusted to belong to anyone (a leftover marker
// proves nothing), and everything this call started is closed on every exit path.
export async function externalLogin(cfg, site, { account = 'default', timeoutSec = 900, url = null, log = () => {}, keepOpen = false } = {}) {
  if (!SITE_COOKIES[site]) throw new Error(`unknown site ${site} (gemini|chatgpt)`);
  const acct = getAccount(cfg, account); // canonical lower-case name; unknown accounts are refused
  if (!acct.enabled) throw Object.assign(new Error(`account "${acct.name}" is disabled`), { code: 2 });
  if (!acct.sites.includes(site)) throw Object.assign(new Error(`account "${acct.name}" is not set up for ${site} (sites: ${acct.sites.join(',')})`), { code: 2 });
  account = acct.name;
  const emb = readEmbeddedInfo();
  if (!emb) throw Object.assign(new Error('the Web AI Hub app (embedded browser) is not running — open it first'), { code: 2 });
  const port = loginPort(cfg);
  const cdpUrl = `http://127.0.0.1:${port}`;
  const profileDir = loginProfileDir(cfg, account);
  const chromeBin = chromePathFor(cfg);
  const startUrl = url || EXTERNAL_LOGIN_URLS[site];
  if (!fs.existsSync(chromeBin)) throw Object.assign(new Error(`Google Chrome not found at ${chromeBin}`), { code: 2 });

  const release = await acquireLoginLock(cfg, { account, site, port });
  syncConfigFromDisk(cfg); // an account removed while we waited for the lock must not be signed in
  try { getAccount(cfg, account); } catch (e) { release(); throw Object.assign(e, { code: 2 }); }
  const ours = () => chromeOwnsPort(port, profileDir, chromeBin);
  let launched = false, aborted = false, cleanup = null, cleanupFailed = false;
  // one idempotent clean-up for every exit path (done, error, TERM/INT, even before Chrome is up):
  // close the Chrome this call started (waiting for it to appear if it is still starting), then unlock
  const cleanupOnce = () => (cleanup ||= (async () => {
    let orphan = false;
    try {
      if (launched && !keepOpen) {
        // wait (bounded) for a Chrome of ours to show up if it is still starting, then close it politely
        for (let i = 0; i < 40 && !(ourChromePids(profileDir, chromeBin) || []).length; i++) await sleep(250);
        if (ours()) await closeChrome(cdpUrl).catch(() => {});
        for (let i = 0; i < 20 && (ourChromePids(profileDir, chromeBin) || [1]).length; i++) await sleep(250);
        // still there (or the process table is unreadable): terminate exactly the processes started with our profile
        // (never an unverified listener)
        const left = ourChromePids(profileDir, chromeBin);
        if (left === null || left.length) { orphan = !(await killOurChrome(profileDir, chromeBin)); cleanupFailed = orphan; }
      }
    } finally {
      if (orphan) console.error(`login-external: could not stop the sign-in Chrome (profile ${profileDir}); close it by hand`);
      release();
    }
  })());
  const onSignal = (sig) => { aborted = true; cleanupOnce().finally(() => process.exit(128 + (sig === 'SIGINT' ? 2 : 15))); };
  process.on('SIGTERM', onSignal); process.on('SIGINT', onSignal);
  try {
    if (await cdpVersion(cdpUrl)) throw Object.assign(new Error(`port ${port} is in use by another browser; finish that first`), { code: 2 });
    fs.mkdirSync(profileDir, { recursive: true, mode: 0o700 });
    const args = [
      `--remote-debugging-port=${port}`, '--remote-debugging-address=127.0.0.1',
      `--user-data-dir=${profileDir}`,
      ...keychainArgs(profileDir, cfg?.gemweb?.mock_keychain),
      '--no-first-run', '--no-default-browser-check', '--window-size=560,760',
      ...(process.env.WEBHUB_LOGIN_HEADLESS === '1' ? ['--headless=new'] : []), // tests only
      startUrl,
    ];
    log(`opening a Chrome sign-in window for ${site} [${account}] (profile ${profileDir})`);
    const appBundle = chromeBin.includes('.app/Contents/MacOS/') ? chromeBin.slice(0, chromeBin.indexOf('.app') + 4) : null;
    // `open -n` starts a separate Chrome instance (own profile) in front, beside the everyday Chrome
    launched = true;
    const ch = process.platform === 'darwin' && appBundle && !process.env.WEBHUB_LOGIN_SPAWN_DIRECT
      ? spawn('/usr/bin/open', ['-n', '-a', appBundle, '--args', ...args], { detached: true, stdio: 'ignore' })
      : spawn(chromeBin, args, { detached: true, stdio: 'ignore' });
    let spawnErr = null;
    ch.on('error', (e) => { spawnErr = e; });
    ch.on('exit', (c) => { if (c) spawnErr = new Error(`launcher exited with code ${c}`); });
    ch.unref();
    let up = false;
    for (let i = 0; i < 75 && !up && !spawnErr && !aborted; i++) { up = ours() && !!(await cdpVersion(cdpUrl)); if (!up) await sleep(200); }
    if (spawnErr) throw new Error(`could not start Chrome: ${spawnErr.message}`);
    if (aborted) throw Object.assign(new Error('cancelled'), { code: 3 });
    if (!up) throw new Error(`the sign-in Chrome did not start (CDP ${cdpUrl})`);

    log(`sign in to ${site === 'gemini' ? 'Google' : 'ChatGPT'} in that Chrome window; waiting up to ${Math.round(timeoutSec / 60)} min…`);
    const deadline = Date.now() + timeoutSec * 1000;
    let cookies = [];
    let ok = false;
    while (Date.now() < deadline && !ok && !aborted) {
      if (!(await cdpVersion(cdpUrl))) throw Object.assign(new Error('the sign-in Chrome was closed before signing in'), { code: 3 });
      if (!ours()) throw Object.assign(new Error(`port ${port} is no longer our sign-in Chrome; stopping`), { code: 3 });
      cookies = await browserCookies(cdpUrl).catch(() => []);
      if (signedInCookies(site, cookies)) {
        await sleep(Number(process.env.WEBHUB_LOGIN_SETTLE_MS) || 3000); // let the post-login redirects set the remaining cookies
        if (!ours()) throw Object.assign(new Error(`port ${port} is no longer our sign-in Chrome; stopping`), { code: 3 });
        cookies = await browserCookies(cdpUrl).catch(() => []);
        ok = signedInCookies(site, cookies); // the session must still be there after settling
      }
      if (!ok) await sleep(2000);
    }
    if (aborted) throw Object.assign(new Error('cancelled'), { code: 3 });
    if (!ok) throw Object.assign(new Error(`not signed in to ${site} within ${timeoutSec}s`), { code: 3 });
    const mine = siteCookies(site, cookies);
    const posted = await postCookiesSettled(emb, account, mine);
    const r = posted.r || { imported: null, failed: null, failed_names: [] }; // after a timeout the final state is judged from the partition below
    if (posted.r && !r.imported) throw Object.assign(new Error(`no cookie could be imported into the app (${r.failed ?? '?'} failed)`), { code: 4 });
    const isSession = SITE_COOKIES[site].signedIn;
    if ((r.failed_names || []).some((n) => mine.some((c) => c.name === n && isSession({ ...c, value: c.value || 'x' })))) throw Object.assign(new Error(`a session cookie could not be written into the app (${r.failed_names.join(', ')})`), { code: 4 });
    // what counts is the partition itself: the session cookie has to be there now
    const have = (await embeddedApi(emb, 'GET', `/cookies/${encodeURIComponent(account)}`).catch(() => ({ cookies: [] }))).cookies || [];
    // every session cookie we copied (all token chunks) must be in the partition under the same name and domain
    const missing = mine.filter((c) => isSession(c) && !have.some((h) => h.name === c.name && String(h.domain).replace(/^\./, '') === String(c.domain).replace(/^\./, '')));
    if (missing.length || !signedInCookies(site, have)) throw Object.assign(new Error(`the ${site} session cookie ${missing.map((c) => c.name).join(',') || ''} did not make it into the app (imported ${r.imported}, failed ${r.failed})`), { code: 4 });
    return { imported: r.imported, failed: r.failed, profile: profileDir };
  } finally {
    await cleanupOnce();
    process.off('SIGTERM', onSignal); process.off('SIGINT', onSignal);
    // never report success (or hide the real error) while a sign-in Chrome is left behind
    if (cleanupFailed) throw Object.assign(new Error(`could not stop the sign-in Chrome (profile ${profileDir}); close it by hand`), { code: 5 });
  }
}
