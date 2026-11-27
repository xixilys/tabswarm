// Dedicated Chrome manager for web-ai-hub: one isolated Chrome profile + CDP endpoint per
// named account (~/.web-ai-hub/chrome-profile on 9230 for "default", ~/.web-ai-hub/profiles/<name>
// on 9231+ for additional accounts), completely separate from everyday Chrome and dsh-browser.
// Headed (visible window) by default with the live Monitor Dashboard pinned as Tab 1.
//
// Tab hygiene: every task tab is recorded in STATE_DIR/run/tabs/<task_id>.json (CDP target ids,
// driver pid, and account). The task closes its own tabs on exit; dead processes' tabs are swept
// on the next attach for that same account.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { STATE_DIR, expandHome, loadSecrets } from './config.js';
import { getAccount, resolveAccounts, cfgForAccount, defaultAccountName, DEFAULT_ACCOUNT } from './accounts.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const DEFAULT_CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const RUN_DIR = () => path.join(STATE_DIR, 'run');
const TABS_DIR = () => path.join(RUN_DIR(), 'tabs');
const suffixFor = (acct) => (!acct || acct === DEFAULT_ACCOUNT ? '' : `-${acct}`);
const PIDFILE = (acct = DEFAULT_ACCOUNT) => path.join(RUN_DIR(), `chrome${suffixFor(acct)}.pid`);
const MODEFILE = (acct = DEFAULT_ACCOUNT) => path.join(RUN_DIR(), `chrome${suffixFor(acct)}.mode`);
const LOCKFILE = (acct = DEFAULT_ACCOUNT) => path.join(RUN_DIR(), `chrome${suffixFor(acct)}.launch.lock`);
const LOGFILE = (acct = DEFAULT_ACCOUNT) => path.join(STATE_DIR, 'logs', `chrome${suffixFor(acct)}.log`);

// Directories that hold the owner's real, signed-in Chrome profiles. Their cookies are encrypted
// with the "Chrome Safe Storage" key in the login keychain, so they must keep using the real
// keychain. Any profile outside them (temp dirs from tests, scratch profiles) is throwaway and
// gets --use-mock-keychain --password-store=basic: otherwise Chrome probes the keychain on start
// and, when it cannot find one, pops a blocking "keychain not found / Reset to defaults" dialog
// that also freezes the browser thread (CDP stops answering).
const REAL_PROFILE_ROOTS = () => [
  path.join(os.homedir(), '.web-ai-hub'),
  path.join(os.homedir(), '.gemini-web-mcp'),
];

function realpathLoose(p) {
  let cur = path.resolve(p); const tail = [];
  for (;;) {
    try { return path.join(fs.realpathSync(cur), ...tail.reverse()); } catch {
      const parent = path.dirname(cur);
      if (parent === cur) return path.resolve(p);
      tail.push(path.basename(cur)); cur = parent;
    }
  }
}

export function isRealProfileDir(profileDir) {
  const lexical = path.resolve(expandHome(profileDir));
  const real = realpathLoose(lexical);
  const inside = (p, root) => p === root || p.startsWith(root + path.sep);
  // lexical OR resolved: ~/.web-ai-hub/chrome-profile stays "real" even if it is a symlink elsewhere
  return REAL_PROFILE_ROOTS().some((root) => inside(lexical, path.resolve(root)) || inside(real, realpathLoose(root)));
}

// Extra Chrome flags for a profile. An explicit `mock_keychain: true|false` on the account (or
// gemweb) wins; otherwise mock the keychain for every profile that is not a real one.
export function keychainArgs(profileDir, override) {
  // A real signed-in profile never gets the mock keychain (its cookies would no longer decrypt);
  // `mock_keychain: false` can turn it off for a throwaway profile.
  const mock = !isRealProfileDir(profileDir) && override !== false;
  return mock ? ['--use-mock-keychain', '--password-store=basic'] : [];
}

export class BrowserBlocked extends Error {
  constructor(kind, detail) {
    super(`BLOCKED: ${kind}|${detail}`);
    this.kind = kind;
    this.detail = detail;
  }
}

export function pidAlive(pid) {
  if (!pid || !Number.isFinite(Number(pid))) return false;
  try { process.kill(Number(pid), 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

function accountContext(cfg, account = null) {
  const want = account || cfg?.gemweb?._account || defaultAccountName(cfg);
  const acct = getAccount(cfg, want);
  const scfg = cfg?.gemweb?._account === acct.name ? cfg : cfgForAccount(cfg, acct.name);
  return { acct, scfg };
}

export function readChromePid(account = DEFAULT_ACCOUNT) {
  try {
    const n = Number(fs.readFileSync(PIDFILE(account), 'utf8').trim());
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch { return null; }
}

export function profileDirFor(cfg, account = null) {
  return accountContext(cfg, account).acct.profile_dir;
}

export function chromePathFor(cfg) {
  return expandHome(cfg?.gemweb?.chrome_path || DEFAULT_CHROME);
}

export function cdpPortFor(cfg, account = null) {
  return String(accountContext(cfg, account).acct.port || 9230);
}

export function monitorUrl(cfg, account = null) {
  const host = cfg?.admin_host || '127.0.0.1';
  const port = cfg?.admin_port || 8782;
  const base = `http://${host}:${port}/`;
  const acct = account || cfg?.gemweb?._account || DEFAULT_ACCOUNT;
  return acct && acct !== DEFAULT_ACCOUNT ? `${base}?account=${encodeURIComponent(acct)}` : base;
}

export async function cdpVersion(cdp) {
  try {
    const r = await fetch(`${cdp}/json/version`, { signal: AbortSignal.timeout(2500) });
    return r.ok ? await r.json() : null;
  } catch { return null; }
}

export async function cdpList(cdp) {
  try {
    const r = await fetch(`${cdp}/json/list`, { signal: AbortSignal.timeout(2500) });
    if (!r.ok) return [];
    const items = await r.json();
    return Array.isArray(items) ? items.filter((t) => t.type === 'page') : [];
  } catch { return []; }
}

export function browserMode(account = DEFAULT_ACCOUNT) {
  try { return fs.readFileSync(MODEFILE(account), 'utf8').trim(); } catch { return ''; }
}

export async function detectBrowserMode(cfg, account = null) {
  const { acct } = accountContext(cfg, account);
  if (browserModeSetting(cfg, acct.name) === 'embedded' && await embeddedUp(readEmbeddedInfo())) return 'embedded';
  const v = await cdpVersion(acct.cdp_url);
  if (!v) return 'down';
  if (/HeadlessChrome/i.test(v['User-Agent'] || '')) return 'headless';
  return browserMode(acct.name) || 'headed';
}

async function acquireLaunchLock(account = DEFAULT_ACCOUNT, timeoutMs = 20000) {
  fs.mkdirSync(RUN_DIR(), { recursive: true, mode: 0o700 });
  const lockPath = LOCKFILE(account);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const fd = fs.openSync(lockPath, 'wx', 0o600);
      fs.writeFileSync(fd, String(process.pid));
      return { fd, lockPath };
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      try {
        const st = fs.statSync(lockPath);
        if (Date.now() - st.mtimeMs > 30000) fs.unlinkSync(lockPath);
      } catch { /* ignore */ }
      await sleep(120);
    }
  }
  return null;
}

function releaseLaunchLock(lock) {
  if (lock) {
    try { fs.closeSync(lock.fd); } catch { /* ignore */ }
    try { fs.unlinkSync(lock.lockPath); } catch { /* ignore */ }
  }
}

async function launchChrome(scfg, acct, { headless, log = () => {} }) {
  const cdp = acct.cdp_url;
  const port = String(acct.port);
  const profileDir = acct.profile_dir;
  const chromeBin = chromePathFor(scfg);
  if (!fs.existsSync(chromeBin)) {
    throw new BrowserBlocked('browser', `Google Chrome binary not found at ${chromeBin}`);
  }
  const logFile = LOGFILE(acct.name);
  fs.mkdirSync(profileDir, { recursive: true, mode: 0o700 });
  fs.mkdirSync(path.dirname(logFile), { recursive: true, mode: 0o700 });
  fs.mkdirSync(RUN_DIR(), { recursive: true, mode: 0o700 });

  const initialUrl = headless ? 'about:blank' : monitorUrl(scfg, acct.name);
  const winSize = scfg?.gemweb?.window_size || '1120,760';
  const winPos = scfg?.gemweb?.window_position || '24,48';
  const args = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profileDir}`,
    ...keychainArgs(profileDir, acct.mock_keychain ?? scfg?.gemweb?.mock_keychain),
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-features=Translate,MediaRouter',
    `--window-size=${winSize}`,
    `--window-position=${winPos}`,
    ...(headless ? ['--headless=new'] : []),
    initialUrl,
  ];
  const bgLaunch = process.platform === 'darwin'
    && !headless
    && scfg?.gemweb?.launch_in_background !== false
    && chromeBin.includes('.app/Contents/MacOS/');

  log(`starting dedicated Chrome [${acct.name}] (${headless ? 'headless' : bgLaunch ? 'background window' : 'visible window'}, port ${port}, profile ${profileDir})`);
  fs.writeFileSync(MODEFILE(acct.name), headless ? 'headless' : 'headed');

  if (bgLaunch) {
    const appBundle = chromeBin.slice(0, chromeBin.indexOf('.app') + 4);
    const launcher = spawn('/usr/bin/open', ['-g', '-n', '-a', appBundle, '--args', ...args], { detached: true, stdio: 'ignore' });
    launcher.unref();
    for (let i = 0; i < 75; i++) {
      if (await cdpVersion(cdp)) {
        const realPid = resolveChromeMainPid(port);
        if (realPid) fs.writeFileSync(PIDFILE(acct.name), String(realPid));
        return realPid;
      }
      await sleep(200);
    }
    throw new BrowserBlocked('browser', `dedicated Chrome [${acct.name}] did not expose CDP on ${cdp} (see ${logFile})`);
  }

  const logFd = fs.openSync(logFile, 'a');
  let child;
  try {
    child = spawn(chromeBin, args, { detached: true, stdio: ['ignore', logFd, logFd] });
    child.unref();
  } finally {
    fs.closeSync(logFd);
  }
  fs.writeFileSync(PIDFILE(acct.name), String(child.pid));

  for (let i = 0; i < 75; i++) {
    if (await cdpVersion(cdp)) return child.pid;
    if (!pidAlive(child.pid)) break;
    await sleep(200);
  }
  throw new BrowserBlocked('browser', `dedicated Chrome [${acct.name}] did not expose CDP on ${cdp} (see ${logFile})`);
}

function resolveChromeMainPid(port) {
  try {
    const out = execFileSync('/bin/ps', ['-eo', 'pid=,command='], { encoding: 'utf8', timeout: 2000 });
    const needle = `--remote-debugging-port=${port}`;
    for (const line of out.split('\n')) {
      if (!line.includes(needle) || line.includes('--type=')) continue;
      const m = /^\s*(\d+)\s/.exec(line);
      if (m) return Number(m[1]);
    }
  } catch { /* ignore */ }
  return null;
}

// ---------------- embedded browser (Web AI Hub desktop app) ----------------
// gemweb.browser_mode: "embedded" (default) runs Gemini/ChatGPT pages inside the desktop app
// (one persistent Electron partition per account, CDP + control API advertised in
// STATE_DIR/run/embedded.json); "chrome" uses the dedicated external Chrome. In embedded mode the
// app is started on demand; when it cannot be reached the external Chrome is the fallback
// (gemweb.embedded.fallback_to_chrome, default on). Per-account override: accounts.<n>.browser_mode.
const EMBEDDED_INFO = () => path.join(RUN_DIR(), 'embedded.json');
const DEFAULT_APP = '/Applications/Web AI Hub.app';

export function browserModeSetting(cfg, account = null) {
  let acct = null;
  try { acct = getAccount(cfg, account || cfg?.gemweb?._account || null); } catch { /* unknown account */ }
  const m = acct?.browser_mode || cfg?.gemweb?.browser_mode || 'embedded';
  return m === 'chrome' ? 'chrome' : 'embedded';
}

export function readEmbeddedInfo() {
  try {
    const info = JSON.parse(fs.readFileSync(EMBEDDED_INFO(), 'utf8'));
    return info?.pid && pidAlive(info.pid) && info.cdp_url && info.control_url ? info : null;
  } catch { return null; }
}

export async function embeddedApi(info, method, p, body = undefined, timeoutMs = 8000) {
  const token = loadSecrets()?.admin_token || '';
  const r = await fetch(`${info.control_url}${p}`, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeoutMs),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok || data.ok === false) throw new Error(`embedded browser ${method} ${p}: ${data.error || r.status}`);
  return data;
}

async function embeddedUp(info) {
  if (!info) return false;
  try { await embeddedApi(info, 'GET', '/health', undefined, 2500); return !!(await cdpVersion(info.cdp_url)); } catch { return false; }
}

function launchDesktopApp(cfg, log) {
  if (process.platform !== 'darwin') return false;
  // The app advertises itself in ITS state dir (the default one unless started with
  // WEBHUB_STATE_DIR); starting it for another state dir (tests, a second hub) cannot help.
  if (path.resolve(STATE_DIR) !== path.join(os.homedir(), '.gemini-web-mcp') && !cfg?.gemweb?.embedded?.app_path) return false;
  const appPath = expandHome(cfg?.gemweb?.embedded?.app_path || DEFAULT_APP);
  if (!fs.existsSync(appPath)) return false;
  log(`starting Web AI Hub desktop app for the embedded browser (${appPath})`);
  spawn('/usr/bin/open', ['-g', '-a', appPath], { detached: true, stdio: 'ignore' }).unref();
  return true;
}

// The embedded browser for this account if it should and can be used, else null (→ external Chrome).
export async function resolveEmbedded(cfg, account = null, { launch = true, log = () => {}, forceChrome = false } = {}) {
  if (forceChrome || browserModeSetting(cfg, account) !== 'embedded') return null;
  let info = readEmbeddedInfo();
  if (await embeddedUp(info)) return info;
  if (launch && launchDesktopApp(cfg, log)) {
    for (let i = 0; i < 100; i++) {
      await sleep(250);
      info = readEmbeddedInfo();
      if (await embeddedUp(info)) return info;
    }
  }
  if (cfg?.gemweb?.embedded?.fallback_to_chrome === false) {
    throw new BrowserBlocked('browser', 'embedded browser (Web AI Hub desktop app) is not running and fallback_to_chrome is off');
  }
  if (launch) log('embedded browser unavailable (desktop app not running) — using the dedicated Chrome', 'warn');
  return null;
}

// accountContext + the live browser behind it: { acct, scfg, embedded } where acct.cdp_url points
// at the embedded browser's CDP when it is used.
export async function liveContext(cfg, account = null, opts = {}) {
  const { acct, scfg } = accountContext(cfg, account);
  const emb = await resolveEmbedded(scfg, acct.name, opts);
  if (!emb) return { acct, scfg, embedded: null };
  let embPort = acct.port;
  try { embPort = Number(new URL(emb.cdp_url).port) || embPort; } catch { /* keep */ }
  return { acct: { ...acct, cdp_url: emb.cdp_url, port: embPort, embedded: true }, scfg, embedded: emb };
}

// Page tabs of one account in its live browser (same shape as cdpList entries).
export async function listTabs(cfg, account = null, opts = { launch: false }) {
  const { acct, embedded } = await liveContext(cfg, account, opts);
  if (!embedded) return cdpList(acct.cdp_url);
  try {
    const { tabs } = await embeddedApi(embedded, 'GET', `/tabs?account=${encodeURIComponent(acct.name)}`);
    return tabs.filter((t) => t.target_id).map((t) => ({ id: t.target_id, type: 'page', url: t.url, title: t.title, embedded_tab: t.id, kind: t.kind }));
  } catch { return []; }
}

async function embeddedNewTab(emb, account, { url = 'about:blank', kind = 'task', taskId = null, select = false, show = false } = {}) {
  const { tab } = await embeddedApi(emb, 'POST', '/tabs', { account, url, kind, task_id: taskId, select, show });
  if (!tab?.target_id) {
    if (tab?.id) await embeddedApi(emb, 'POST', `/tabs/${tab.id}/close`).catch(() => {});
    throw new BrowserBlocked('browser', 'embedded browser created a tab without a CDP target id');
  }
  return tab;
}

async function embeddedOwns(emb, targetId) {
  const { tabs } = await embeddedApi(emb, 'GET', '/tabs').catch(() => ({ tabs: [] }));
  return tabs.some((t) => t.target_id === targetId || t.id === targetId);
}

async function pageForTarget(context, targetId, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const p of context.pages()) {
      if (await targetIdOf(context, p).catch(() => null) === targetId) return p;
    }
    await sleep(80);
  }
  return null;
}

// Starts the dedicated Chrome for an account if it is not running.
export async function ensureDedicated(cfg, log = () => {}, { headless, ensureMonitorTab = false, account = null } = {}) {
  const { acct, scfg } = accountContext(cfg, account);
  const emb = await resolveEmbedded(scfg, acct.name, { log, forceChrome: cfg?.gemweb?._force_chrome === true });
  if (emb) return cdpVersion(emb.cdp_url);
  const cdp = acct.cdp_url;
  const wantHeadless = headless !== undefined ? !!headless : acct.headless === true;
  let v = await cdpVersion(cdp);
  if (!v) {
    const lock = await acquireLaunchLock(acct.name);
    try {
      v = await cdpVersion(cdp);
      if (!v) await launchChrome(scfg, acct, { headless: wantHeadless, log });
    } finally {
      releaseLaunchLock(lock);
    }
  }
  if (!wantHeadless && ensureMonitorTab) {
    const baseMon = `http://${scfg?.admin_host || '127.0.0.1'}:${scfg?.admin_port || 8782}/`;
    const tabs = await cdpList(cdp);
    const hasMon = tabs.some((t) => (t.url || '').startsWith(baseMon));
    if (!hasMon) await openTab(scfg, monitorUrl(scfg, acct.name), { activate: false, account: acct.name }).catch(() => {});
  }
  return v || await cdpVersion(cdp);
}

export async function stopDedicated(cfg, account = null) {
  const { acct } = accountContext(cfg, account);
  if (browserModeSetting(cfg, acct.name) === 'embedded' && await embeddedUp(readEmbeddedInfo()) && !cfg?.gemweb?._force_chrome) {
    // the embedded browser belongs to the desktop app: close this account's tabs, keep the app
    const emb = readEmbeddedInfo();
    const { tabs } = await embeddedApi(emb, 'GET', `/tabs?account=${encodeURIComponent(acct.name)}`).catch(() => ({ tabs: [] }));
    for (const t of tabs) await embeddedApi(emb, 'POST', `/tabs/${t.id}/close`).catch(() => {});
    return { stopped: false, embedded: true, closed_tabs: tabs.length, account: acct.name, pid: null };
  }
  const pid = readChromePid(acct.name);
  if (!pid || !pidAlive(pid)) {
    try { fs.unlinkSync(PIDFILE(acct.name)); } catch { /* ignore */ }
    try { fs.unlinkSync(MODEFILE(acct.name)); } catch { /* ignore */ }
    return { stopped: false, account: acct.name, pid: null, still_up: !!(await cdpVersion(acct.cdp_url)) };
  }
  try { process.kill(pid, 'SIGTERM'); } catch { /* ignore */ }
  for (let i = 0; i < 25; i++) {
    if (!pidAlive(pid) && !(await cdpVersion(acct.cdp_url))) break;
    await sleep(200);
  }
  if (pidAlive(pid)) {
    try { process.kill(pid, 'SIGKILL'); } catch { /* ignore */ }
    await sleep(300);
  }
  try { fs.unlinkSync(PIDFILE(acct.name)); } catch { /* ignore */ }
  try { fs.unlinkSync(MODEFILE(acct.name)); } catch { /* ignore */ }
  return { stopped: true, account: acct.name, pid };
}

export function bringChromeFront(cfg, account = null, targetId = null) {
  const emb = browserModeSetting(cfg, account) === 'embedded' ? readEmbeddedInfo() : null;
  if (emb) { embeddedApi(emb, 'POST', '/show', { tab: targetId }).catch(() => {}); return true; }
  if (process.platform !== 'darwin') return false;
  const { acct } = accountContext(cfg, account);
  const pid = readChromePid(acct.name);
  if (!pid || !pidAlive(pid) || browserMode(acct.name) === 'headless') return false;
  try {
    execFileSync('osascript', [
      '-e',
      `tell application "System Events" to set frontmost of (first process whose unix id is ${pid}) to true`,
    ], { timeout: 4000, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

export async function findTargetAccount(cfg, targetId) {
  const emb = readEmbeddedInfo();
  if (emb) {
    const { tabs } = await embeddedApi(emb, 'GET', '/tabs').catch(() => ({ tabs: [] }));
    const hit = tabs.find((t) => t.target_id === targetId);
    if (hit) return hit.account;
  }
  const accounts = resolveAccounts(cfg);
  const hits = await Promise.all(accounts.map(async (a) => {
    const tabs = await cdpList(a.cdp_url);
    return tabs.some((t) => t.id === targetId) ? a.name : null;
  }));
  return hits.find(Boolean) || null;
}

async function createBackgroundPage(browser, context) {
  let targetId = null;
  const bs = await browser.newBrowserCDPSession().catch(() => null);
  if (bs) {
    try {
      const res = await bs.send('Target.createTarget', { url: 'about:blank', background: true });
      targetId = res?.targetId || null;
    } catch { /* fall back to context.newPage */ } finally {
      await bs.detach().catch(() => {});
    }
  }
  let page = null;
  if (targetId) {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline && !page) {
      for (const p of context.pages()) {
        if (await targetIdOf(context, p).catch(() => null) === targetId) { page = p; break; }
      }
      if (!page) await sleep(50);
    }
  }
  if (!page) page = await context.newPage();
  const ps = await context.newCDPSession(page).catch(() => null);
  if (ps) {
    await ps.send('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {});
    page.once('close', () => ps.detach().catch(() => {}));
  }
  return page;
}

export async function openTab(cfg, url, { activate = true, bringToFront = false, account = null, kind = 'manual' } = {}) {
  const { acct, scfg, embedded } = await liveContext(cfg, account);
  if (embedded) {
    const tab = await embeddedNewTab(embedded, acct.name, { url, kind, select: activate, show: bringToFront });
    return { target_id: tab.target_id, url, account: acct.name, embedded: true };
  }
  await ensureDedicated(scfg, () => {}, { account: acct.name });
  const { chromium } = await import('playwright-core');
  const browser = await chromium.connectOverCDP(acct.cdp_url, { timeout: 15000 });
  try {
    const context = browser.contexts()[0] || await browser.newContext();
    const page = activate ? await context.newPage() : await createBackgroundPage(browser, context);
    const tid = await targetIdOf(context, page).catch(() => null);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
    if (activate && tid) {
      const bs = await browser.newBrowserCDPSession();
      try { await bs.send('Target.activateTarget', { targetId: tid }); } finally { await bs.detach().catch(() => {}); }
    }
    if (bringToFront) bringChromeFront(scfg, acct.name);
    return { target_id: tid, url: page.url(), account: acct.name };
  } finally {
    await browser.close().catch(() => {});
  }
}

export async function focusTab(cfg, targetId, { bringToFront = true, account = null } = {}) {
  const resolved = account || await findTargetAccount(cfg, targetId);
  const { acct: acct0, embedded } = await liveContext(cfg, resolved, { launch: false });
  if (embedded && await embeddedOwns(embedded, targetId)) {
    try { await embeddedApi(embedded, 'POST', `/tabs/${encodeURIComponent(targetId)}/focus`); return true; } catch { return false; }
  }
  const { acct, scfg } = accountContext(cfg, acct0.name);
  if (!(await cdpVersion(acct.cdp_url))) return false;
  const { chromium } = await import('playwright-core');
  const browser = await chromium.connectOverCDP(acct.cdp_url, { timeout: 10000 });
  try {
    const bs = await browser.newBrowserCDPSession();
    try {
      await bs.send('Target.activateTarget', { targetId });
      if (bringToFront) bringChromeFront(scfg, acct.name);
      return true;
    } catch { return false; } finally { await bs.detach().catch(() => {}); }
  } finally {
    await browser.close().catch(() => {});
  }
}

export async function closeTab(cfg, targetId, { account = null } = {}) {
  const resolved = account || await findTargetAccount(cfg, targetId);
  const live = await liveContext(cfg, resolved, { launch: false });
  if (live.embedded && await embeddedOwns(live.embedded, targetId)) {
    try { await embeddedApi(live.embedded, 'POST', `/tabs/${encodeURIComponent(targetId)}/close`); return true; } catch { return false; }
  }
  const { acct } = accountContext(cfg, resolved);
  if (!(await cdpVersion(acct.cdp_url))) return false;
  const { chromium } = await import('playwright-core');
  const browser = await chromium.connectOverCDP(acct.cdp_url, { timeout: 10000 });
  try {
    const bs = await browser.newBrowserCDPSession();
    try {
      await bs.send('Target.closeTarget', { targetId });
      return true;
    } catch { return false; } finally { await bs.detach().catch(() => {}); }
  } finally {
    await browser.close().catch(() => {});
  }
}

// Headless Chrome announces itself ("HeadlessChrome" in the UA and client hints); some sites
// (Cloudflare-style bot checks) then refuse to load. Present the normal Chrome UA instead.
export function normalUserAgent(ua) { return String(ua || '').replace(/HeadlessChrome/g, 'Chrome'); }
export function uaMetadata(ua) {
  const full = /Chrome\/([\d.]+)/.exec(ua)?.[1] || '0.0.0.0';
  const major = full.split('.')[0];
  return {
    brands: [{ brand: 'Google Chrome', version: major }, { brand: 'Chromium', version: major }, { brand: 'Not.A/Brand', version: '99' }],
    fullVersion: full, platform: 'macOS', platformVersion: '15.0.0', architecture: os.arch() === 'arm64' ? 'arm' : 'x86', model: '', mobile: false,
  };
}

function registryPath(taskId) { return path.join(TABS_DIR(), `${String(taskId).replace(/[^\w.-]/g, '_')}.json`); }
function readRegistry(taskId) { try { return JSON.parse(fs.readFileSync(registryPath(taskId), 'utf8')); } catch { return null; } }
function writeRegistry(taskId, rec) { fs.mkdirSync(TABS_DIR(), { recursive: true }); fs.writeFileSync(registryPath(taskId), JSON.stringify(rec)); }

export function readTabRegistries(account = null) {
  const byTarget = new Map();
  let files = [];
  try { files = fs.readdirSync(TABS_DIR()); } catch { return byTarget; }
  for (const f of files) {
    if (!f.endsWith('.json')) continue;
    try {
      const rec = JSON.parse(fs.readFileSync(path.join(TABS_DIR(), f), 'utf8'));
      const recAcct = rec.account || DEFAULT_ACCOUNT;
      if (account && recAcct !== account) continue;
      const alive = pidAlive(rec.pid);
      for (const tid of rec.targets || []) {
        byTarget.set(tid, { task_id: rec.task_id, pid: rec.pid, alive, created: rec.created, account: recAcct });
      }
    } catch { /* skip */ }
  }
  return byTarget;
}

export function registeredTargets(account = null) {
  const out = new Set();
  let files = []; try { files = fs.readdirSync(TABS_DIR()); } catch { /* none */ }
  for (const f of files) {
    try {
      const rec = JSON.parse(fs.readFileSync(path.join(TABS_DIR(), f), 'utf8'));
      if (account && (rec.account || DEFAULT_ACCOUNT) !== account) continue;
      for (const t of rec.targets || []) out.add(t);
    } catch { /* skip */ }
  }
  return out;
}

export async function targetIdOf(context, page) {
  const s = await context.newCDPSession(page);
  try { return (await s.send('Target.getTargetInfo')).targetInfo.targetId; } finally { await s.detach().catch(() => {}); }
}

export function recordTarget(taskId, targetId, extra = {}) {
  const rec = readRegistry(taskId) || { task_id: taskId, account: extra.account || DEFAULT_ACCOUNT, pid: process.pid, targets: [], created: new Date().toISOString() };
  rec.pid = process.pid; Object.assign(rec, extra);
  if (!rec.targets.includes(targetId)) rec.targets.push(targetId);
  writeRegistry(taskId, rec);
}

// Connection to the dedicated Chrome for one task (scoped to one account).
export class Dedicated {
  static async connect(cfg, taskId, log = () => {}, { account = null, forceChrome = false } = {}) {
    const { acct, scfg, embedded } = await liveContext(cfg, account, { log, forceChrome });
    if (!embedded) await ensureDedicated({ ...scfg, gemweb: { ...scfg.gemweb, _force_chrome: true } }, log, { account: acct.name });
    const { chromium } = await import('playwright-core');
    const browser = await chromium.connectOverCDP(acct.cdp_url, { timeout: 20000 });
    const context = browser.contexts()[0] || await browser.newContext();
    const d = new Dedicated(scfg, browser, context, taskId, acct.name);
    d.embedded = embedded;
    await d.sweepOrphans(log).catch(() => {});
    return d;
  }

  constructor(cfg, browser, context, taskId, account = DEFAULT_ACCOUNT) {
    this.cfg = cfg;
    this.browser = browser;
    this.context = context;
    this.taskId = taskId;
    this.account = account;
    this.ua = null;
  }

  async userAgent() {
    if (this.ua === null) {
      const s = await this.browser.newBrowserCDPSession();
      try { this.ua = (await s.send('Browser.getVersion')).userAgent || ''; } finally { await s.detach().catch(() => {}); }
    }
    return this.ua;
  }

  // A new tab owned by this task: created in background by default so macOS Chrome stays behind active apps.
  get label() { return this.embedded ? `embedded browser [${this.account}]` : `dedicated Chrome [${this.account}]`; }

  async newPage({ background = true } = {}) {
    let page;
    if (this.embedded) {
      // Electron's CDP cannot create targets: the desktop app makes the tab, we attach to it
      const tab = await embeddedNewTab(this.embedded, this.account, { kind: 'task', taskId: this.taskId });
      page = await pageForTarget(this.context, tab.target_id);
      if (!page) {
        await embeddedApi(this.embedded, 'POST', `/tabs/${tab.id}/close`).catch(() => {});
        throw new BrowserBlocked('browser', `embedded tab ${tab.target_id} did not appear over CDP`);
      }
      const ps = await this.context.newCDPSession(page).catch(() => null);
      if (ps) { await ps.send('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {}); page.once('close', () => ps.detach().catch(() => {})); }
    } else page = background ? await createBackgroundPage(this.browser, this.context) : await this.context.newPage();
    try { recordTarget(this.taskId, await targetIdOf(this.context, page), { account: this.account, host: this.embedded ? 'embedded' : 'chrome' }); } catch { /* recorded by pid sweep anyway */ }
    await this.fixUserAgent(page);
    return page;
  }

  async fixUserAgent(page) {
    const ua = await this.userAgent().catch(() => '');
    if (!/HeadlessChrome/.test(ua)) return;
    const s = await this.context.newCDPSession(page);
    const nua = normalUserAgent(ua);
    await s.send('Emulation.setUserAgentOverride', { userAgent: nua, acceptLanguage: 'en-US,en;q=0.9', platform: 'MacIntel', userAgentMetadata: uaMetadata(nua) }).catch(() => {});
    page.once('close', () => s.detach().catch(() => {}));
  }

  // Pages that appeared since `before` (e.g. opened by the operator model) and belong to no
  // other task are adopted by this task so they get closed with it.
  async adoptNewPages(before) {
    const others = registeredTargets(this.account);
    const mine = this.embedded ? new Set((await listTabs(this.cfg, this.account)).map((t) => t.id)) : null;
    for (const p of this.context.pages()) {
      if (before.has(p)) continue;
      const id = await targetIdOf(this.context, p).catch(() => null);
      if (mine && !mine.has(id)) continue; // another account's (or the dashboard's) page in the shared embedded CDP
      if (id && !others.has(id)) recordTarget(this.taskId, id, { account: this.account });
    }
  }

  async closeTarget(targetId) {
    const s = await this.browser.newBrowserCDPSession();
    try { await s.send('Target.closeTarget', { targetId }); return true; } catch { return false; } finally { await s.detach().catch(() => {}); }
  }

  // Closes every tab this task opened. Returns how many were closed.
  async closeTaskTabs(keep = new Set()) {
    const rec = readRegistry(this.taskId);
    let n = 0;
    for (const t of rec?.targets || []) if (!keep.has(t) && await this.closeTarget(t)) n++;
    if (!keep.size) { try { fs.unlinkSync(registryPath(this.taskId)); } catch { /* gone */ } } else writeRegistry(this.taskId, { ...rec, targets: rec.targets.filter((t) => keep.has(t)) });
    return n;
  }

  // Tabs whose process is gone (crash, kill -9) in THIS account's Chrome are closed.
  async sweepOrphans(log = () => {}) {
    let files = []; try { files = fs.readdirSync(TABS_DIR()); } catch { return 0; }
    let n = 0;
    for (const f of files) {
      const p = path.join(TABS_DIR(), f);
      let rec; try { rec = JSON.parse(fs.readFileSync(p, 'utf8')); } catch { continue; }
      if ((rec.account || DEFAULT_ACCOUNT) !== this.account) continue;
      if (rec.task_id === this.taskId || pidAlive(rec.pid)) continue;
      for (const t of rec.targets || []) if (await this.closeTarget(t)) n++;
      try { fs.unlinkSync(p); } catch { /* gone */ }
    }
    if (n) log(`closed ${n} tab(s) left behind by an earlier run`);
    return n;
  }

  async disconnect() { await this.browser.close().catch(() => {}); } // drops CDP; the Chrome keeps running
}

// ---------------- login ----------------
export const LOGIN_URLS = { gemini: 'https://gemini.google.com/app?hl=en', chatgpt: 'https://chatgpt.com/' };

export async function openLoginWindow(cfg, site, { account = null } = {}) {
  const url = LOGIN_URLS[site];
  if (!url) throw new Error(`unknown site ${site} (gemini|chatgpt)`);
  const { acct, scfg } = accountContext(cfg, account);
  const live = await liveContext(scfg, acct.name);
  if (live.embedded) {
    const host = new URL(url).hostname;
    const existing = (await listTabs(scfg, acct.name)).find((t) => { try { return new URL(t.url).hostname === host; } catch { return false; } });
    if (existing) { await focusTab(scfg, existing.id, { account: acct.name }); return { target_id: existing.id, url: existing.url, reused: true, account: acct.name, embedded: true }; }
    const tab = await embeddedNewTab(live.embedded, acct.name, { url, kind: 'login', select: true, show: true });
    return { target_id: tab.target_id, url, account: acct.name, embedded: true };
  }
  const mode = await detectBrowserMode(scfg, acct.name);
  if (mode === 'headless') {
    await stopDedicated(scfg, acct.name);
    await sleep(500);
  }
  await ensureDedicated(scfg, () => {}, { headless: false, ensureMonitorTab: true, account: acct.name });
  const tabs = await cdpList(acct.cdp_url);
  const host = new URL(url).hostname;
  const existing = tabs.find((t) => {
    try { return new URL(t.url).hostname === host; } catch { return false; }
  });
  if (existing) {
    await focusTab(scfg, existing.id, { bringToFront: true, account: acct.name });
    return { target_id: existing.id, url: existing.url, reused: true, account: acct.name };
  }
  return await openTab(scfg, url, { activate: true, bringToFront: true, account: acct.name });
}

export async function restartHeadless(cfg, { account = null } = {}) {
  const { acct, scfg: scfg0 } = accountContext(cfg, account);
  const scfg = { ...scfg0, gemweb: { ...scfg0.gemweb, _force_chrome: true } }; // never touch the embedded tabs
  await stopDedicated(scfg, acct.name);
  await sleep(1000);
  await ensureDedicated(scfg, () => {}, { headless: true, account: acct.name });
}

// Closes the tabs recorded for a task through a fresh CDP connection (end of task, signals).
export async function closeTaskTabsFor(cfg, taskId) {
  const rec = readRegistry(taskId);
  if (!rec?.targets?.length) { try { fs.unlinkSync(registryPath(taskId)); } catch { /* none */ } return 0; }
  // a task that fell back to the dedicated Chrome keeps its tabs there even while the app runs
  const { acct, scfg, embedded } = await liveContext(cfg, rec.account || DEFAULT_ACCOUNT, { launch: false, forceChrome: rec.host === 'chrome' });
  if (!(await cdpVersion(acct.cdp_url))) return 0;
  const { chromium } = await import('playwright-core');
  const browser = await chromium.connectOverCDP(acct.cdp_url, { timeout: 15000 });
  const d = new Dedicated(scfg, browser, browser.contexts()[0], taskId, acct.name);
  d.embedded = embedded;
  try { return await d.closeTaskTabs(); } finally { await d.disconnect(); }
}
