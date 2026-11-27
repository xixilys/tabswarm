// Multi-account registry and live config sync for web-ai-hub.
// Each named account owns its own Chrome user-data-dir, CDP port, per-site concurrency/quota
// settings, and login session. "default" always maps to the primary ~/.web-ai-hub/chrome-profile
// and gemweb.cdp_url (default http://127.0.0.1:9230) so existing setups stay 100% compatible.
import fs from 'node:fs';
import path from 'node:path';
import { CONFIG_PATH, STATE_DIR, expandHome, DEFAULT_CONFIG } from './config.js';

export const DEFAULT_ACCOUNT = 'default';
export const VALID_SITES = ['gemini', 'chatgpt'];
export const ACCOUNT_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,23}$/;
const RESERVED_NAMES = new Set(['auto', 'all']);

const lastMtime = new WeakMap();

export function validateAccountName(name) {
  const s = String(name || '').trim().toLowerCase();
  if (!ACCOUNT_NAME_RE.test(s) || RESERVED_NAMES.has(s)) {
    throw Object.assign(
      new Error(`invalid account name "${name}" (use 1-24 lowercase a-z, 0-9, -, _; cannot be "auto" or "all")`),
      { status: 400 },
    );
  }
  return s;
}

export function normalizeSites(raw, fallback = VALID_SITES) {
  if (raw === undefined || raw === null) return [...fallback];
  const arr = Array.isArray(raw) ? raw : String(raw).split(',');
  const out = [];
  for (const item of arr) {
    const s = String(item || '').trim().toLowerCase();
    if (VALID_SITES.includes(s) && !out.includes(s)) out.push(s);
  }
  return out;
}

// ports the app itself uses: sign-in Chrome (9238) and the embedded browser (9240 CDP, 9241 control)
export function reservedPorts(cfg) {
  const e = cfg?.gemweb?.embedded || {};
  return [9229, Number(e.login_port) || 9238, Number(e.cdp_port) || 9240, Number(e.control_port) || 9241];
}

function portFromCdp(cdpUrl, fallbackPort = 9230) {
  try {
    const u = new URL(cdpUrl);
    return Number(u.port || (u.protocol === 'https:' ? 443 : 80));
  } catch {
    return fallbackPort;
  }
}

export function defaultAccountName(cfg) {
  const raw = String(cfg?.gemweb?.default_account || DEFAULT_ACCOUNT).trim().toLowerCase();
  if (!raw || raw === DEFAULT_ACCOUNT) return DEFAULT_ACCOUNT;
  const accts = cfg?.gemweb?.accounts || {};
  return (raw in accts && accts[raw]?.enabled !== false) ? raw : DEFAULT_ACCOUNT;
}

export function resolveAccounts(cfg) {
  const g = cfg?.gemweb || DEFAULT_CONFIG.gemweb;
  const rawMap = g.accounts || {};
  const rawDef = String(g.default_account || DEFAULT_ACCOUNT).trim().toLowerCase();
  const extraNames = Object.keys(rawMap)
    .filter((k) => k !== DEFAULT_ACCOUNT && ACCOUNT_NAME_RE.test(k) && !RESERVED_NAMES.has(k));
  const defTarget = (rawDef && rawDef !== DEFAULT_ACCOUNT && extraNames.includes(rawDef) && rawMap[rawDef]?.enabled !== false)
    ? rawDef
    : DEFAULT_ACCOUNT;

  const defOver = rawMap[DEFAULT_ACCOUNT] || {};
  const defCdp = defOver.cdp_url || g.cdp_url || DEFAULT_CONFIG.gemweb.cdp_url;
  const defProfileRaw = defOver.profile_dir || g.profile_dir || DEFAULT_CONFIG.gemweb.profile_dir;
  const defSites = defOver.sites !== undefined ? normalizeSites(defOver.sites) : [...VALID_SITES];
  const usedPorts = new Set([portFromCdp(defCdp, 9230), ...reservedPorts(cfg)]);

  const list = [{
    name: DEFAULT_ACCOUNT,
    label: String(defOver.label || 'Default').slice(0, 60),
    enabled: defOver.enabled !== false,
    sites: defSites.length ? defSites : [...VALID_SITES],
    cdp_url: defCdp,
    port: portFromCdp(defCdp, 9230),
    profile_dir_raw: defProfileRaw,
    profile_dir: path.resolve(expandHome(defProfileRaw)),
    concurrency: Math.max(1, Number(defOver.concurrency ?? g.concurrency ?? 3)),
    daily_limit: Math.max(0, Number(defOver.daily_limit ?? g.daily_limit ?? 30)),
    min_interval_sec: Math.max(0, Number(defOver.min_interval_sec ?? g.min_interval_sec ?? 10)),
    headless: defOver.headless !== undefined ? !!defOver.headless : (g.headless === true),
    ...(typeof defOver.mock_keychain === 'boolean' ? { mock_keychain: defOver.mock_keychain } : {}),
    ...(['embedded', 'chrome'].includes(defOver.browser_mode) ? { browser_mode: defOver.browser_mode } : {}),
    is_default: defTarget === DEFAULT_ACCOUNT,
  }];

  for (const name of extraNames) {
    const r = rawMap[name] || {};
    let port = r.port ? Number(r.port) : (r.cdp_url ? portFromCdp(r.cdp_url, 0) : 0);
    if (!port) {
      port = 9231;
      while (usedPorts.has(port)) port++;
    }
    usedPorts.add(port);
    const cdpUrl = r.cdp_url || `http://127.0.0.1:${port}`;
    const profRaw = r.profile_dir || `~/.web-ai-hub/profiles/${name}`;
    const sites = r.sites !== undefined ? normalizeSites(r.sites) : [...VALID_SITES];
    list.push({
      name,
      label: String(r.label || name).slice(0, 60),
      enabled: r.enabled !== false,
      sites: sites.length ? sites : [...VALID_SITES],
      cdp_url: cdpUrl,
      port: portFromCdp(cdpUrl, port),
      profile_dir_raw: profRaw,
      profile_dir: path.resolve(expandHome(profRaw)),
      concurrency: Math.max(1, Number(r.concurrency ?? g.concurrency ?? 3)),
      daily_limit: Math.max(0, Number(r.daily_limit ?? g.daily_limit ?? 30)),
      min_interval_sec: Math.max(0, Number(r.min_interval_sec ?? g.min_interval_sec ?? 10)),
      headless: r.headless !== undefined ? !!r.headless : (g.headless === true),
      ...(typeof r.mock_keychain === 'boolean' ? { mock_keychain: r.mock_keychain } : {}),
      ...(['embedded', 'chrome'].includes(r.browser_mode) ? { browser_mode: r.browser_mode } : {}),
      is_default: defTarget === name,
    });
  }
  return list;
}

export function getAccount(cfg, name = null) {
  const list = resolveAccounts(cfg);
  const want = name ? String(name).trim().toLowerCase() : defaultAccountName(cfg);
  const hit = list.find((a) => a.name === want);
  if (!hit) {
    throw Object.assign(
      new Error(`unknown account "${want}" (configured: ${list.map((a) => a.name).join(', ')})`),
      { status: 404 },
    );
  }
  return hit;
}

export function cfgForAccount(cfg, accountName = null) {
  const acct = getAccount(cfg, accountName);
  return {
    ...(cfg || {}),
    gemweb: {
      ...(cfg?.gemweb || DEFAULT_CONFIG.gemweb),
      cdp_url: acct.cdp_url,
      profile_dir: acct.profile_dir,
      concurrency: acct.concurrency,
      daily_limit: acct.daily_limit,
      min_interval_sec: acct.min_interval_sec,
      headless: acct.headless,
      _account: acct.name,
    },
  };
}

export function nextFreePort(cfg) {
  const used = new Set([...reservedPorts(cfg), ...resolveAccounts(cfg).map((a) => Number(a.port))]);
  let port = 9231;
  while (used.has(port)) port++;
  return port;
}

// ---- config.json is read-modified-written by several processes (server, CLI, app): one at a time ----
// Same protocol as the sign-in lock (src/login-external.js), synchronous: each process publishes its own
// file config.<pid>.cfglock (rename into place), lists the files, removes only dead processes' files, and
// backs off while another live process has one. Nothing ever deletes a live owner's file.
let cfgLockDepth = 0;
function pidAliveSync(pid) { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } }
function sleepSync(ms) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }
export function withConfigLock(fn) {
  if (cfgLockDepth > 0) return fn(); // re-entrant inside one process
  fs.mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
  const mine = path.join(STATE_DIR, `config.${process.pid}.cfglock`);
  const tmp = `${mine}.${Date.now()}.tmp`;
  const others = () => fs.readdirSync(STATE_DIR).map((n) => /^config\.(\d+)\.cfglock$/.exec(n)).filter(Boolean).map((m) => Number(m[1])).filter((pid) => {
    if (pid === process.pid) return false;
    if (pidAliveSync(pid)) return true;
    try { fs.unlinkSync(path.join(STATE_DIR, `config.${pid}.cfglock`)); } catch { /* gone */ }
    return false;
  });
  let got = false;
  for (let i = 0; i < 100 && !got; i++) { // ~ up to 10 s
    try {
      fs.writeFileSync(tmp, String(process.pid), { mode: 0o600 });
      fs.renameSync(tmp, mine);
      if (!others().length) got = true;
      else { fs.unlinkSync(mine); sleepSync(40 + Math.floor(Math.random() * 80)); }
    } catch (e) { try { fs.unlinkSync(tmp); } catch { /* none */ } try { fs.unlinkSync(mine); } catch { /* none */ } throw e; }
  }
  if (!got) throw Object.assign(new Error('another process is changing config.json; try again'), { status: 409 });
  cfgLockDepth++;
  try { return fn(); } finally { cfgLockDepth--; try { fs.unlinkSync(mine); } catch { /* gone */ } }
}
// raw read-modify-write of the user config file under that lock (for callers outside this module)
export function updateUserConfig(mutator) {
  return withConfigLock(() => { const user = readUserConfig(); const out = mutator(user); writeUserConfig(user); return out; });
}

function readUserConfig() {
  try {
    if (fs.existsSync(CONFIG_PATH)) return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch { /* fall through */ }
  return {};
}

function writeUserConfig(user) {
  fs.mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
  const tmp = `${CONFIG_PATH}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(user, null, 2) + '\n', { mode: 0o600 });
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, CONFIG_PATH);
}

function applyUserToRuntime(cfg, user) {
  if (!cfg) return;
  cfg.gemweb ||= {};
  const ug = user.gemweb || {};
  cfg.gemweb.accounts = ug.accounts ? JSON.parse(JSON.stringify(ug.accounts)) : {};
  if (ug.default_account !== undefined) cfg.gemweb.default_account = ug.default_account;
  else cfg.gemweb.default_account = DEFAULT_ACCOUNT;
  if (ug.auto_failover !== undefined) cfg.gemweb.auto_failover = !!ug.auto_failover;
  if (ug.concurrency !== undefined) cfg.gemweb.concurrency = ug.concurrency;
  if (ug.min_interval_sec !== undefined) cfg.gemweb.min_interval_sec = ug.min_interval_sec;
  if (ug.daily_limit !== undefined) cfg.gemweb.daily_limit = ug.daily_limit;
  if (ug.headless !== undefined) cfg.gemweb.headless = ug.headless;
  if (ug.cdp_url !== undefined) cfg.gemweb.cdp_url = ug.cdp_url;
  if (ug.profile_dir !== undefined) cfg.gemweb.profile_dir = ug.profile_dir;
  try { lastMtime.set(cfg, fs.statSync(CONFIG_PATH).mtimeMs); } catch { /* ignore */ }
}

export function syncConfigFromDisk(cfg) {
  if (!cfg) return false;
  let mt = 0;
  try { mt = fs.statSync(CONFIG_PATH).mtimeMs; } catch { return false; }
  if (lastMtime.get(cfg) === mt) return false;
  try {
    const user = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    applyUserToRuntime(cfg, user);
    return true;
  } catch {
    return false;
  }
}

export function upsertAccountInConfig(cfg, rawName, opts = {}) { return withConfigLock(() => upsertAccountInConfig_(cfg, rawName, opts)); }
function upsertAccountInConfig_(cfg, rawName, opts = {}) {
  syncConfigFromDisk(cfg);
  const name = validateAccountName(rawName);
  const existing = resolveAccounts(cfg).find((a) => a.name === name);
  const others = resolveAccounts(cfg).filter((a) => a.name !== name);

  let port = opts.port !== undefined && opts.port !== null && opts.port !== '' ? Number(opts.port) : null;
  let cdpUrl = opts.cdp_url ? String(opts.cdp_url).trim() : null;
  if (port !== null && (!Number.isInteger(port) || port < 1024 || port > 65535)) {
    throw Object.assign(new Error(`invalid CDP port ${opts.port}`), { status: 400 });
  }
  if (!cdpUrl && port) cdpUrl = `http://127.0.0.1:${port}`;
  if (!cdpUrl && existing) {
    cdpUrl = existing.cdp_url;
    port = existing.port;
  }
  if (!cdpUrl) {
    port = nextFreePort(cfg);
    cdpUrl = `http://127.0.0.1:${port}`;
  }
  const effectivePort = portFromCdp(cdpUrl, port || 9231);
  if (reservedPorts(cfg).includes(effectivePort) || others.some((a) => Number(a.port) === effectivePort)) {
    throw Object.assign(new Error(`CDP port ${effectivePort} is reserved or already in use by another account, the Web AI Hub app or dsh-browser`), { status: 400 });
  }

  let sites;
  if (opts.sites !== undefined) {
    sites = normalizeSites(opts.sites, []);
    if (!sites.length) {
      throw Object.assign(new Error('sites must include at least one of: gemini, chatgpt'), { status: 400 });
    }
  } else {
    sites = existing ? existing.sites : [...VALID_SITES];
  }

  const profRaw = opts.profile_dir
    ? String(opts.profile_dir)
    : (existing?.profile_dir_raw || (name === DEFAULT_ACCOUNT ? '~/.web-ai-hub/chrome-profile' : `~/.web-ai-hub/profiles/${name}`));
  fs.mkdirSync(path.resolve(expandHome(profRaw)), { recursive: true, mode: 0o700 });

  const entry = {
    ...(existing && (cfg?.gemweb?.accounts?.[name]) ? cfg.gemweb.accounts[name] : {}),
    label: opts.label !== undefined ? String(opts.label).trim() || name : (existing?.label || (name === DEFAULT_ACCOUNT ? 'Default' : name)),
    enabled: opts.enabled !== undefined ? !!opts.enabled : (existing ? existing.enabled : true),
    sites,
    cdp_url: cdpUrl,
    port: effectivePort,
    profile_dir: profRaw,
  };
  if (opts.concurrency !== undefined && opts.concurrency !== null && opts.concurrency !== '') {
    const c = Number(opts.concurrency);
    if (!Number.isFinite(c) || c < 1) throw Object.assign(new Error('concurrency must be >= 1'), { status: 400 });
    entry.concurrency = Math.floor(c);
  }
  if (opts.daily_limit !== undefined && opts.daily_limit !== null && opts.daily_limit !== '') {
    const d = Number(opts.daily_limit);
    if (!Number.isFinite(d) || d < 0) throw Object.assign(new Error('daily_limit must be >= 0'), { status: 400 });
    entry.daily_limit = Math.floor(d);
  }
  if (opts.min_interval_sec !== undefined && opts.min_interval_sec !== null && opts.min_interval_sec !== '') {
    const m = Number(opts.min_interval_sec);
    if (!Number.isFinite(m) || m < 0) throw Object.assign(new Error('min_interval_sec must be >= 0'), { status: 400 });
    entry.min_interval_sec = m;
  }
  if (opts.headless !== undefined) entry.headless = !!opts.headless;

  const user = readUserConfig();
  user.gemweb ||= {};
  user.gemweb.accounts ||= {};
  user.gemweb.accounts[name] = entry;
  if (name === DEFAULT_ACCOUNT) {
    user.gemweb.cdp_url = cdpUrl;
    user.gemweb.profile_dir = profRaw;
  }
  writeUserConfig(user);
  applyUserToRuntime(cfg, user);
  return getAccount(cfg, name);
}

export function removeAccountFromConfig(cfg, rawName) { return withConfigLock(() => removeAccountFromConfig_(cfg, rawName)); }
function removeAccountFromConfig_(cfg, rawName) {
  syncConfigFromDisk(cfg);
  const name = validateAccountName(rawName);
  if (name === DEFAULT_ACCOUNT) {
    throw Object.assign(new Error('cannot remove the "default" account'), { status: 400 });
  }
  const acct = getAccount(cfg, name);
  const user = readUserConfig();
  if (user.gemweb?.accounts) delete user.gemweb.accounts[name];
  if (user.gemweb?.default_account === name) user.gemweb.default_account = DEFAULT_ACCOUNT;
  writeUserConfig(user);
  applyUserToRuntime(cfg, user);
  return acct;
}

export function setAccountEnabledInConfig(cfg, rawName, enabled) { return withConfigLock(() => setAccountEnabledInConfig_(cfg, rawName, enabled)); }
function setAccountEnabledInConfig_(cfg, rawName, enabled) {
  syncConfigFromDisk(cfg);
  const name = validateAccountName(rawName);
  getAccount(cfg, name);
  return upsertAccountInConfig(cfg, name, { enabled: !!enabled });
}

export function setDefaultAccountInConfig(cfg, rawName) { return withConfigLock(() => setDefaultAccountInConfig_(cfg, rawName)); }
function setDefaultAccountInConfig_(cfg, rawName) {
  syncConfigFromDisk(cfg);
  const name = validateAccountName(rawName);
  const acct = getAccount(cfg, name);
  if (!acct.enabled) {
    throw Object.assign(new Error(`cannot set disabled account "${name}" as default`), { status: 400 });
  }
  const user = readUserConfig();
  user.gemweb ||= {};
  user.gemweb.default_account = name;
  writeUserConfig(user);
  applyUserToRuntime(cfg, user);
  return getAccount(cfg, name);
}
