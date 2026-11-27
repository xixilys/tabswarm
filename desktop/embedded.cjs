// Embedded browser for Web AI Hub desktop: Gemini / ChatGPT pages live inside this app as
// WebContentsViews (one persistent partition per account, persist:webhub-<account>), instead of a
// separate dedicated Chrome. The web-ai-hub driver (src/browser.js) controls them through:
//   - Electron's own CDP endpoint (127.0.0.1:<cdp_port>, default 9240) for page automation;
//   - a small local control API (127.0.0.1:<control_port>, default 9241, bearer = admin_token)
//     for what Electron's CDP cannot do: create a tab (Target.createTarget is "Not supported"),
//     list tabs per account, show/focus a tab, import cookies into an account's partition.
// Both are advertised in STATE_DIR/run/embedded.json while the app runs.
//
// Pages must keep running while the window is hidden or minimized: every view has
// backgroundThrottling:false, the app starts with the renderer-backgrounding switches off (see
// applyEmbeddedSwitches), unselected views stay "visible" but are parked off-screen (a hidden
// WebContentsView collapses to a 0x0 viewport), and App Nap is blocked while task tabs exist.
const { WebContentsView, session, powerSaveBlocker, shell } = require('electron');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const SITE_URLS = { gemini: 'https://gemini.google.com/app?hl=en', chatgpt: 'https://chatgpt.com/' };
// tests point the sites at local fixtures (never set in the packaged app)
if (process.env.WEBHUB_DESKTOP_SITE_URLS) Object.assign(SITE_URLS, JSON.parse(process.env.WEBHUB_DESKTOP_SITE_URLS));
// (tests only) local fixture origins stand in for the real sites
const TEST_SITE_ORIGINS = process.env.WEBHUB_DESKTOP_SITE_URLS
  ? Object.fromEntries(Object.entries(SITE_URLS).map(([k, u]) => { try { return [k, new URL(u).origin]; } catch { return [k, null]; } }))
  : null;
const ACCOUNT_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const MAX_TABS = 24;

function applyEmbeddedSwitches(app, { cdpPort }) {
  app.commandLine.appendSwitch('remote-debugging-address', '127.0.0.1');
  app.commandLine.appendSwitch('remote-debugging-port', String(cdpPort));
  // keep timers / rendering going for pages that are not on screen
  app.commandLine.appendSwitch('disable-renderer-backgrounding');
  app.commandLine.appendSwitch('disable-background-timer-throttling');
  app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
  app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion,IntensiveWakeUpThrottling');
}

// The normal Chrome UA: drop "Electron/x" and the app's own token so sites treat the pages as Chrome.
function chromeUserAgent(ua) {
  return String(ua || '')
    .replace(/\s+Electron\/[\d.]+/g, '')
    .replace(/\s+(web-ai-hub-desktop|Web AI Hub|Web%20AI%20Hub)\/[\d.]+/gi, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function siteOf(url) {
  try {
    if (TEST_SITE_ORIGINS) { const o = new URL(url).origin; for (const k of ['chatgpt', 'gemini']) if (TEST_SITE_ORIGINS[k] === o) return k; }
    const h = new URL(url).hostname;
    if (h === 'gemini.google.com') return 'gemini';
    if (h === 'chatgpt.com' || h.endsWith('.chatgpt.com') || h === 'chat.openai.com' || h === 'auth.openai.com') return 'chatgpt';
  } catch { /* ignore */ }
  return 'other';
}

// Google refuses sign-in inside embedded browsers ("this browser or app may not be secure").
// Those page loads are stopped and the sign-in goes to a normal Chrome window instead
// (`webhub browser login-external`, src/login-external.js), whose session is then copied in.
function isGoogleSignin(u) {
  try {
    const x = new URL(u);
    return x.hostname === 'accounts.google.com' && /^\/(ServiceLogin|AccountChooser|AddSession|InteractiveLogin|signin|v3\/signin|o\/oauth2)/i.test(x.pathname);
  } catch { return false; }
}

class EmbeddedBrowser {
  constructor({ window, stateDir, adminToken, cdpPort = 9240, controlPort = 9241, topInset = 44, onChange = () => {}, dashboardView = null, log = () => {}, onExternalLogin = null }) {
    this.window = window;
    this.stateDir = stateDir;
    this.adminToken = adminToken;
    this.cdpPort = cdpPort;
    this.controlPort = controlPort;
    this.topInset = topInset;
    this.onChange = onChange;
    this.dashboardView = dashboardView;
    this.log = log;
    this.onExternalLogin = onExternalLogin;
    this.ops = new Map(); // account -> tail of its serialized cookie operations (import / purge)
    this.pending = null; // the one sign-in in progress: { account, site, tabs:Set<tabId>, promise }
    this.notice = '';
    this.tabs = new Map(); // id -> tab
    this.selected = 'dashboard';
    this.blocker = null;
    this.server = null;
    this.sessions = new Set();
    window.on('resize', () => this.layout());
    for (const ev of ['show', 'restore', 'maximize', 'unmaximize', 'enter-full-screen', 'leave-full-screen']) window.on(ev, () => this.layout());
  }

  partitionFor(account) { return `persist:webhub-${account}`; }

  sessionFor(account) {
    const s = session.fromPartition(this.partitionFor(account));
    if (!this.sessions.has(s)) {
      this.sessions.add(s);
      s.setUserAgent(chromeUserAgent(s.getUserAgent()));
      // sites ask for notifications/clipboard etc.; allow the harmless ones, deny the rest
      s.setPermissionRequestHandler((_wc, perm, cb) => cb(['clipboard-sanitized-write', 'clipboard-read', 'fullscreen', 'notifications'].includes(perm)));
    }
    return s;
  }

  // ---------- tabs ----------
  contentBounds() {
    const [w, h] = this.window.getContentSize();
    return { x: 0, y: this.topInset, width: Math.max(320, w), height: Math.max(240, h - this.topInset) };
  }

  layout() {
    if (this.window.isDestroyed()) return;
    const b = this.contentBounds();
    const parked = { x: b.width + 10, y: b.y, width: b.width, height: b.height }; // off-screen, still "visible"
    if (this.dashboardView) this.dashboardView.setBounds(this.selected === 'dashboard' ? b : parked);
    for (const t of this.tabs.values()) {
      if (t.view.webContents.isDestroyed()) continue;
      t.view.setBounds(this.selected === t.id ? b : parked);
      t.view.setVisible(true);
      this.emulateViewport(t, b);
    }
  }

  // A parked view, or any view of a hidden/minimized window, gets a 0x0 renderer viewport, and
  // automation then fails ("element is outside of the viewport"). Task tabs therefore always run
  // with an explicit viewport of the content size. It is only re-applied when the size changes:
  // every (re)application fires a resize, which closes ChatGPT's open menus mid-selection.
  emulateViewport(t, b = this.contentBounds()) {
    if (t.kind !== 'task' || !t.rendererReady) return; // before the renderer exists this crashes Electron
    const wc = t.view.webContents;
    if (wc.isDestroyed() || (t.emu && t.emu.width === b.width && t.emu.height === b.height)) return;
    wc.enableDeviceEmulation({
      screenPosition: 'desktop',
      screenSize: { width: b.width, height: b.height },
      viewPosition: { x: 0, y: 0 },
      deviceScaleFactor: 0,
      viewSize: { width: b.width, height: b.height },
      scale: 1,
    });
    t.emu = { width: b.width, height: b.height };
  }

  async createTab({ account = 'default', url = 'about:blank', kind = 'manual', task_id = null, select = false } = {}) {
    if (!ACCOUNT_RE.test(account)) throw Object.assign(new Error(`bad account name: ${account}`), { status: 400 });
    if (this.tabs.size >= MAX_TABS) throw Object.assign(new Error(`too many embedded tabs (${MAX_TABS}); close some first`), { status: 429 });
    const id = crypto.randomBytes(6).toString('hex');
    const view = new WebContentsView({
      webPreferences: {
        session: this.sessionFor(account),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        spellcheck: false,
        backgroundThrottling: false,
      },
    });
    const wc = view.webContents;
    wc.setBackgroundThrottling(false);
    this.window.contentView.addChildView(view, 0); // below the dashboard/notices; z-order does not matter, bounds do
    const tab = { id, account, kind, task_id, view, target_id: null, title: '', url, site: siteOf(url), home: siteOf(url), created: new Date().toISOString() };
    this.tabs.set(id, tab);
    const openHandler = ({ url: u }) => {
      if (tab.kind !== 'task' && isGoogleSignin(u)) { this.externalLogin(tab); return { action: 'deny' }; }
      // (tests only) a local stand-in for ChatGPT's auth.openai.com relay popup
      const relay = !!TEST_SITE_ORIGINS && /^\/oauth-popup/.test(new URL(u, 'http://x').pathname) && Object.values(TEST_SITE_ORIGINS).includes(new URL(u).origin);
      // sign-in popups (Google / Apple / Microsoft for ChatGPT) must share the account's partition
      if (relay || /^https:\/\/(accounts\.google\.com|appleid\.apple\.com|login\.microsoftonline\.com|login\.live\.com|auth\.openai\.com)\//.test(u)) {
        return { action: 'allow', overrideBrowserWindowOptions: { width: 520, height: 720, webPreferences: { session: this.sessionFor(account), backgroundThrottling: false } } };
      }
      if (siteOf(u) !== 'other') { this.createTab({ account, url: u, kind: 'manual', select: true }).catch(() => {}); return { action: 'deny' }; }
      shell.openExternal(u).catch(() => {});
      return { action: 'deny' };
    };
    wc.setWindowOpenHandler(openHandler);
    // an allowed sign-in popup (e.g. auth.openai.com) can itself bounce to Google: guard it like the tab
    const watchPopups = (owner) => owner.on('did-create-window', (child) => {
      const cwc = child.webContents;
      cwc.setWindowOpenHandler(openHandler); // a popup's own popups follow the same rules
      const stop = () => { try { child.close(); } catch { /* ignore */ } this.externalLogin(tab); };
      const hit = (e, legacyUrl, _p, legacyMain) => {
        const u = e?.url || legacyUrl;
        if ((e?.isMainFrame ?? legacyMain) !== false && isGoogleSignin(u) && tab.kind !== 'task') { e.preventDefault(); stop(); }
      };
      cwc.on('will-navigate', hit);
      cwc.on('will-redirect', hit);
      cwc.on('did-navigate', () => { if (!cwc.isDestroyed() && tab.kind !== 'task' && isGoogleSignin(cwc.getURL())) stop(); }); // safety net
      watchPopups(cwc);
    });
    watchPopups(wc);
    const sync = () => {
      if (wc.isDestroyed()) return;
      tab.title = wc.getTitle(); tab.url = wc.getURL(); tab.site = siteOf(tab.url);
      if (tab.site !== 'other') tab.home = tab.site;
      if (tab.kind !== 'task' && isGoogleSignin(tab.url)) this.externalLogin(tab); // safety net: a sign-in page got through
      this.changed();
    };
    // main-frame navigations/redirects to Google's sign-in never load in here
    const guard = (e, legacyUrl, _inPlace, legacyMain) => {
      const u = e?.url || legacyUrl;
      const main = e?.isMainFrame ?? legacyMain;
      if (main !== false && tab.kind !== 'task' && isGoogleSignin(u)) { e.preventDefault(); this.externalLogin(tab); }
    };
    wc.on('will-navigate', guard);
    wc.on('will-redirect', guard);
    wc.on('page-title-updated', sync);
    wc.on('did-navigate', sync);
    wc.on('did-navigate-in-page', sync);
    // Target.closeTarget from the driver destroys the WebContents: drop the view with it
    wc.once('destroyed', () => this.forget(id));
    // Emulation lives in the renderer's widget: (re)apply once each new document is ready (a
    // cross-site navigation swaps the renderer); no menu can be open at that point.
    wc.on('dom-ready', () => { tab.rendererReady = true; tab.emu = null; this.emulateViewport(tab); });
    wc.on('render-process-gone', () => { tab.rendererReady = false; tab.emu = null; });
    const dbg = wc.debugger;
    try {
      dbg.attach('1.3');
      tab.target_id = (await dbg.sendCommand('Target.getTargetInfo')).targetInfo.targetId;
    } catch (e) {
      this.log(`embedded: could not read target id: ${e.message}`);
    } finally {
      try { dbg.detach(); } catch { /* ignore */ }
    }
    if (select) this.selected = id;
    this.layout();
    this.syncPowerBlocker();
    if (url && url !== 'about:blank') wc.loadURL(url).catch(() => {});
    else wc.loadURL('about:blank').catch(() => {});
    this.changed();
    return this.describe(tab);
  }

  // Sign in through a normal Chrome window, then reload the tabs that asked for it with the copied
  // session. One sign-in at a time (they share one debugging port); other pages are left alone.
  externalLogin(tab) {
    const site = tab.home === 'chatgpt' ? 'chatgpt' : 'gemini';
    const wc = tab.view.webContents;
    const hint = `webhub browser login-external ${site} --account ${tab.account}`;
    if (/\/signin\/rejected/.test(wc.isDestroyed() ? '' : wc.getURL())) this.reloadTabs(new Map([[tab.id, wc.getURL()]]), site);
    if (!this.onExternalLogin) { this.setNotice(`Google 不允许在内嵌页登录：请运行 ${hint}`); return; }
    const label = site === 'gemini' ? 'Google（Gemini）' : 'ChatGPT';
    if (this.pending) {
      if (this.pending.account === tab.account && this.pending.site === site) this.pending.tabs.set(tab.id, wc.isDestroyed() ? '' : wc.getURL());
      else this.setNotice(`已有一个登录窗口在进行中（${this.pending.site}${this.pending.account !== 'default' ? ` / ${this.pending.account}` : ''}），请先完成它`, 8000);
      return;
    }
    this.setNotice(`Google 不允许在内嵌页登录，已用 Chrome 打开 ${label} 登录窗口；登完会自动回到这里`);
    const pending = { account: tab.account, site, tabs: new Map([[tab.id, wc.isDestroyed() ? '' : wc.getURL()]]), promise: null };
    this.pending = pending;
    pending.promise = Promise.resolve().then(() => this.onExternalLogin({ account: tab.account, site, tab: tab.id }))
      .then((r) => {
        if (r?.ok) this.setNotice(`${label} 登录已导入${tab.account !== 'default' ? `（账号 ${tab.account}）` : ''}`, 8000);
        else this.setNotice(`${label} 登录没有完成：${String(r?.error || '已取消').slice(0, 120)}`, 15000);
        this.reloadTabs(pending.tabs, site);
      })
      .catch((e) => this.setNotice(`登录失败：${e.message}`, 15000))
      .finally(() => { if (this.pending === pending) this.pending = null; this.changed(); });
    this.changed();
  }

  // back to the site's home for exactly these tabs (the ones that triggered / waited for the sign-in)
  reloadTabs(urls, site) {
    for (const [id, was] of urls) {
      const t = this.tabs.get(id);
      if (!t || t.kind === 'task' || t.view.webContents.isDestroyed()) continue;
      // only a page still where it was when it asked: one the user has since moved elsewhere is left alone
      if (t.view.webContents.getURL() !== was) continue;
      t.view.webContents.loadURL(SITE_URLS[site]).catch(() => {});
    }
  }

  setNotice(text, clearAfterMs = 0) {
    this.notice = text;
    clearTimeout(this._noticeT);
    if (clearAfterMs) this._noticeT = setTimeout(() => { this.notice = ''; this.changed(); }, clearAfterMs);
    this.changed();
  }

  forget(id) {
    const t = this.tabs.get(id);
    if (!t) return;
    this.tabs.delete(id);
    try { if (!this.window.isDestroyed()) this.window.contentView.removeChildView(t.view); } catch { /* ignore */ }
    if (this.selected === id) this.selected = 'dashboard';
    this.layout();
    this.syncPowerBlocker();
    this.changed();
  }

  closeTab(id) {
    const t = this.find(id);
    if (!t) return false;
    const wc = t.view.webContents;
    this.forget(t.id);
    if (!wc.isDestroyed()) wc.close();
    return true;
  }

  find(idOrTarget) {
    return this.tabs.get(idOrTarget) || [...this.tabs.values()].find((t) => t.target_id === idOrTarget) || null;
  }

  select(id) {
    if (id === 'dashboard' || this.find(id)) {
      this.selected = id === 'dashboard' ? 'dashboard' : this.find(id).id;
      this.layout();
      const v = this.selected === 'dashboard' ? this.dashboardView : this.tabs.get(this.selected)?.view;
      v?.webContents?.focus();
      this.changed();
      return true;
    }
    return false;
  }

  show(id = null) {
    if (id) this.select(id);
    if (this.window.isMinimized()) this.window.restore();
    this.window.show();
    this.window.focus();
  }

  describe(t) {
    const wc = t.view.webContents;
    return {
      id: t.id, target_id: t.target_id, account: t.account, kind: t.kind, task_id: t.task_id,
      site: t.site, title: wc.isDestroyed() ? t.title : wc.getTitle(), url: wc.isDestroyed() ? t.url : wc.getURL(),
      selected: this.selected === t.id, created: t.created, partition: this.partitionFor(t.account),
    };
  }

  list(account = null) {
    return [...this.tabs.values()].filter((t) => !account || t.account === account).map((t) => this.describe(t));
  }

  syncPowerBlocker() {
    const busy = [...this.tabs.values()].some((t) => t.kind === 'task');
    if (busy && this.blocker === null) this.blocker = powerSaveBlocker.start('prevent-app-suspension');
    if (!busy && this.blocker !== null) { powerSaveBlocker.stop(this.blocker); this.blocker = null; }
  }

  changed() {
    clearTimeout(this._chg);
    this._chg = setTimeout(() => this.onChange(this.snapshot()), 60);
  }

  snapshot() {
    return { selected: this.selected, tabs: this.list(), notice: this.notice, logins: this.pending ? [`${this.pending.account}:${this.pending.site}`] : [], cdp_url: `http://127.0.0.1:${this.cdpPort}` };
  }

  // Cookie imports and purges of one account run one after another: a purge cannot overtake an import
  // whose HTTP request already arrived (even if the CLI gave up waiting), so nothing is written after it.
  serial(account, fn) {
    const prev = this.ops.get(account) || Promise.resolve();
    const run = prev.catch(() => {}).then(fn);
    const tail = run.catch(() => {});
    this.ops.set(account, tail);
    tail.then(() => { if (this.ops.get(account) === tail) this.ops.delete(account); });
    return run;
  }

  async importCookies(account, cookies) {
    const s = this.sessionFor(account);
    let ok = 0, failed = 0;
    const failedNames = [];
    for (const c of cookies || []) {
      const host = String(c.domain || '').replace(/^\./, '');
      if (!host) { failed++; failedNames.push(c.name); continue; }
      const details = {
        url: `https://${host}${c.path || '/'}`,
        name: c.name, value: c.value, path: c.path || '/',
        secure: c.secure !== false, httpOnly: !!c.httpOnly,
        ...(String(c.domain).startsWith('.') ? { domain: c.domain } : {}),
        ...(c.expires && c.expires > 0 ? { expirationDate: c.expires } : {}),
        ...(c.sameSite ? { sameSite: ({ Strict: 'strict', Lax: 'lax', None: 'no_restriction' })[c.sameSite] || 'unspecified' } : {}),
      };
      try { await s.cookies.set(details); ok++; } catch { failed++; failedNames.push(c.name); }
    }
    await s.cookies.flushStore().catch(() => {});
    return { imported: ok, failed, failed_names: failedNames };
  }

  // ---------- control API ----------
  start() {
    this.server = http.createServer((req, res) => this.handle(req, res).catch((e) => this.send(res, e.status || 500, { ok: false, error: e.message })));
    return new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(this.controlPort, '127.0.0.1', () => { this.writeInfo(); resolve(); });
    });
  }

  infoPath() { return path.join(this.stateDir, 'run', 'embedded.json'); }

  writeInfo() {
    fs.mkdirSync(path.dirname(this.infoPath()), { recursive: true, mode: 0o700 });
    fs.writeFileSync(this.infoPath(), JSON.stringify({
      pid: process.pid, cdp_url: `http://127.0.0.1:${this.cdpPort}`, control_url: `http://127.0.0.1:${this.controlPort}`,
      started: new Date().toISOString(), partitions: 'persist:webhub-<account>',
    }), { mode: 0o600 });
  }

  stop() {
    try { const cur = JSON.parse(fs.readFileSync(this.infoPath(), 'utf8')); if (cur.pid === process.pid) fs.unlinkSync(this.infoPath()); } catch { /* ignore */ }
    this.server?.close();
    if (this.blocker !== null) { powerSaveBlocker.stop(this.blocker); this.blocker = null; }
  }

  send(res, status, body) {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  }

  authorized(req) {
    const tok = typeof this.adminToken === 'function' ? this.adminToken() : this.adminToken;
    const got = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    if (!tok || !got || got.length !== tok.length) return false;
    return crypto.timingSafeEqual(Buffer.from(got), Buffer.from(tok));
  }

  async body(req) {
    let raw = '';
    for await (const chunk of req) { raw += chunk; if (raw.length > 4e6) throw Object.assign(new Error('body too large'), { status: 413 }); }
    try { return raw ? JSON.parse(raw) : {}; } catch { throw Object.assign(new Error('bad json'), { status: 400 }); }
  }

  async handle(req, res) {
    // browsers never get here with the token; also refuse any cross-site request outright
    if (req.headers.origin) return this.send(res, 403, { ok: false, error: 'cross-origin requests are not allowed' });
    if (!this.authorized(req)) return this.send(res, 401, { ok: false, error: 'unauthorized' });
    const url = new URL(req.url, 'http://x');
    const p = url.pathname;
    if (req.method === 'GET' && p === '/health') return this.send(res, 200, { ok: true, pid: process.pid, cdp_url: `http://127.0.0.1:${this.cdpPort}`, tabs: this.tabs.size });
    if (req.method === 'GET' && p === '/state') return this.send(res, 200, { ok: true, ...this.snapshot() });
    if (req.method === 'GET' && p === '/tabs') return this.send(res, 200, { ok: true, tabs: this.list(url.searchParams.get('account')) });
    if (req.method === 'POST' && p === '/tabs') {
      const b = await this.body(req);
      const site = b.site && SITE_URLS[b.site] ? b.site : null;
      const tab = await this.createTab({ account: b.account || 'default', url: b.url || (site ? SITE_URLS[site] : 'about:blank'), kind: ['task', 'manual', 'login'].includes(b.kind) ? b.kind : 'manual', task_id: b.task_id || null, select: !!b.select });
      if (b.show) this.show(tab.id);
      return this.send(res, 200, { ok: true, tab });
    }
    let m = /^\/tabs\/([\w-]+)\/(close|focus)$/.exec(p);
    if (req.method === 'POST' && m) {
      const ok = m[2] === 'close' ? this.closeTab(m[1]) : (this.show(m[1]), !!this.find(m[1]));
      return this.send(res, ok ? 200 : 404, { ok });
    }
    if (req.method === 'POST' && p === '/show') { this.show((await this.body(req)).tab || null); return this.send(res, 200, { ok: true }); }
    if (req.method === 'POST' && p === '/cookies') {
      const b = await this.body(req);
      if (!ACCOUNT_RE.test(b.account || '')) return this.send(res, 400, { ok: false, error: 'account required' });
      return this.send(res, 200, { ok: true, ...(await this.serial(b.account, () => this.importCookies(b.account, b.cookies))) });
    }
    if (req.method === 'POST' && p === '/barrier') {
      // resolves once every import/purge already queued for this account has finished (even if its HTTP caller gave up)
      const b = await this.body(req);
      if (!ACCOUNT_RE.test(b.account || '')) return this.send(res, 400, { ok: false, error: 'account required' });
      await this.serial(b.account, async () => {});
      return this.send(res, 200, { ok: true });
    }
    if (req.method === 'POST' && p === '/purge') {
      const b = await this.body(req);
      if (!ACCOUNT_RE.test(b.account || '')) return this.send(res, 400, { ok: false, error: 'account required' });
      return this.serial(b.account, async () => {
        for (const t of [...this.tabs.values()]) if (t.account === b.account) this.closeTab(t.id);
        const s = this.sessionFor(b.account);
        await s.clearStorageData();
        await s.clearCache();
        await s.cookies.flushStore().catch(() => {});
        const left = (await s.cookies.get({})).length;
        if (left) return this.send(res, 500, { ok: false, error: `${left} cookie(s) still in the partition after clearing` });
        return this.send(res, 200, { ok: true, cleared: true });
      });
    }
    m = /^\/cookies\/([\w-]+)$/.exec(p);
    if (req.method === 'GET' && m) {
      // names + domains only (never values): lets `webhub browser status` tell whether an account is signed in
      const all = await this.sessionFor(m[1]).cookies.get({});
      return this.send(res, 200, { ok: true, cookies: all.map((c) => ({ name: c.name, domain: c.domain })) });
    }
    return this.send(res, 404, { ok: false, error: 'not found' });
  }
}

module.exports = { EmbeddedBrowser, applyEmbeddedSwitches, chromeUserAgent, siteOf, isGoogleSignin, SITE_URLS };
