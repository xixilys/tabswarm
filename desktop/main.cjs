const { app, BrowserWindow, WebContentsView, Tray, Menu, MenuItem, nativeImage, shell, dialog, ipcMain } = require('electron');
const { EmbeddedBrowser, applyEmbeddedSwitches, SITE_URLS } = require('./embedded.cjs');
const { execFile } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const STATE_DIR = process.env.WEBHUB_STATE_DIR || process.env.GWM_STATE_DIR || path.join(os.homedir(), '.gemini-web-mcp');
const SECRETS_PATH = path.join(STATE_DIR, 'secrets.json');
function readHubConfig() {
  try { return JSON.parse(fs.readFileSync(path.join(STATE_DIR, 'config.json'), 'utf8')); } catch { return {}; }
}
const HUB_CFG = readHubConfig();
// honour a custom admin_port instead of assuming 8782
const ADMIN_PORT = Number(HUB_CFG.admin_port) || 8782;
const ADMIN_BASE = `http://127.0.0.1:${ADMIN_PORT}`;
const ADMIN_URL = `${ADMIN_BASE}/`;
const STATE_URL = `${ADMIN_BASE}/api/state`;
// Embedded Gemini/ChatGPT tabs (see embedded.cjs). The ports must be fixed before app ready.
const EMB_CFG = HUB_CFG.gemweb?.embedded || {};
// Electron's CDP (like the dedicated Chrome's) is unauthenticated on loopback: only open it when
// some account actually uses the embedded browser.
const EMBEDDED_USED = (HUB_CFG.gemweb?.browser_mode || 'embedded') !== 'chrome'
  || Object.values(HUB_CFG.gemweb?.accounts || {}).some((a) => a?.browser_mode === 'embedded');
const EMBEDDED_ON = EMB_CFG.enabled !== false && EMBEDDED_USED;
const EMB_CDP_PORT = Number(EMB_CFG.cdp_port) || 9240;
const EMB_CONTROL_PORT = Number(EMB_CFG.control_port) || 9241;
if (EMBEDDED_ON) applyEmbeddedSwitches(app, { cdpPort: EMB_CDP_PORT });
// For tests (scripts/embedded-test.mjs): separate userData (own single-instance lock and partitions),
// no tray icon, hidden window, never start the real background service.
const HEADLESS_SHELL = process.env.WEBHUB_DESKTOP_HEADLESS === '1';
if (process.env.WEBHUB_DESKTOP_USER_DATA) app.setPath('userData', process.env.WEBHUB_DESKTOP_USER_DATA);
const LOGS_DIR = path.join(STATE_DIR, 'logs');
const WEBHUB_BIN = process.env.WEBHUB_DESKTOP_WEBHUB_BIN || path.join(os.homedir(), '.local/bin/webhub');
// the service manager next to the CLI the app talks to (bin/webhub.mjs -> bin/gwmcp)
const GWMCP_BIN = process.env.WEBHUB_DESKTOP_GWMCP_BIN || (() => { try { return path.join(path.dirname(fs.realpathSync(WEBHUB_BIN)), 'gwmcp'); } catch { return path.join(__dirname, '..', 'bin', 'gwmcp'); } })();

let mainWindow = null;
let dashboardView = null;
let embedded = null;
let accountNames = ['default'];
let tray = null;
let pollTimer = null;
let isQuitting = false;

const runningChildren = new Set(); // helper CLIs (e.g. the Chrome sign-in); stopped when the app quits
function runExec(cmd, args, timeoutMs = 15000) {
  return new Promise((resolve) => {
    const child = execFile(cmd, args, {
      timeout: timeoutMs,
      env: { ...process.env, PATH: `/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:${os.homedir()}/.local/bin` },
    }, (err, stdout, stderr) => {
      runningChildren.delete(child);
      resolve({ ok: !err, code: err ? err.code : 0, stdout: String(stdout || ''), stderr: String(stderr || '') });
    });
    runningChildren.add(child);
  });
}

function readAdminToken() {
  try {
    return JSON.parse(fs.readFileSync(SECRETS_PATH, 'utf8')).admin_token || '';
  } catch {
    return '';
  }
}

async function fetchState(timeoutMs = 1800) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(STATE_URL, { signal: controller.signal });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function apiPost(pathname, body = {}) {
  const token = readAdminToken();
  const res = await fetch(`${ADMIN_BASE}${pathname}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
  return res.ok;
}

async function startBackendService() {
  if (fs.existsSync(GWMCP_BIN)) {
    const r = await runExec(GWMCP_BIN, ['start'], 20000);
    if (r.ok) return true;
  }
  if (fs.existsSync(WEBHUB_BIN)) {
    const r = await runExec(WEBHUB_BIN, ['start'], 20000);
    return r.ok;
  }
  return false;
}

async function ensureServerRunning() {
  if (await fetchState(1200)) return true;
  if (HEADLESS_SHELL) return false;
  await startBackendService();
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 500));
    if (await fetchState(1200)) return true;
  }
  return false;
}

function showMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindow();
    return;
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

async function connectDashboard() {
  if (!dashboardView || dashboardView.webContents.isDestroyed()) return;
  const ok = await ensureServerRunning();
  if (ok) {
    dashboardView.webContents.loadURL(ADMIN_URL).catch(() => {});
  } else {
    dashboardView.webContents.loadFile(path.join(__dirname, 'splash.html'), { query: { offline: '1' } }).catch(() => {});
  }
}

function pushShellState() {
  if (!mainWindow || mainWindow.isDestroyed() || !embedded) return;
  mainWindow.webContents.send('shell:state', { ...embedded.snapshot(), accounts: accountNames });
}

async function openEmbedded(site, account = 'default') {
  if (!embedded) return null;
  showMainWindow();
  return embedded.createTab({ account, url: SITE_URLS[site] || SITE_URLS.chatgpt, kind: 'manual', select: true });
}

function createWindow() {
  const iconPath = path.join(__dirname, 'build', 'icon.png');
  mainWindow = new BrowserWindow({
    width: 1320,
    height: 860,
    minWidth: 960,
    minHeight: 640,
    backgroundColor: '#0b101b',
    title: 'Web AI Hub',
    show: !HEADLESS_SHELL,
    icon: fs.existsSync(iconPath) ? iconPath : undefined,
    webPreferences: {
      preload: path.join(__dirname, 'shell-preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  // The window itself only draws the tab bar (shell.html); the dashboard and every embedded
  // Gemini/ChatGPT page are WebContentsViews laid out below it.
  mainWindow.loadFile(path.join(__dirname, 'shell.html')).catch(() => {});

  dashboardView = new WebContentsView({
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  mainWindow.contentView.addChildView(dashboardView);
  const dwc = dashboardView.webContents;
  dwc.loadFile(path.join(__dirname, 'splash.html')).catch(() => {});

  dwc.setWindowOpenHandler(({ url }) => {
    if (!url.startsWith(ADMIN_URL)) {
      shell.openExternal(url).catch(() => {});
      return { action: 'deny' };
    }
    return { action: 'allow' };
  });

  dwc.on('will-navigate', (event, url) => {
    if (!url.startsWith(ADMIN_URL) && !url.startsWith('file://')) {
      event.preventDefault();
      shell.openExternal(url).catch(() => {});
    }
  });

  dwc.on('did-fail-load', (_e, errorCode, _desc, validatedURL) => {
    if (errorCode === -3) return; // aborted navigation
    if (validatedURL && validatedURL.startsWith(ADMIN_URL)) {
      dwc.loadFile(path.join(__dirname, 'splash.html'), {
        query: { offline: '1', msg: `连接控制台失败（错误码 ${errorCode}），请确认本地服务是否运行。` },
      }).catch(() => {});
    }
  });

  embedded = new EmbeddedBrowser({
    window: mainWindow,
    stateDir: STATE_DIR,
    adminToken: readAdminToken,
    cdpPort: EMB_CDP_PORT,
    controlPort: EMB_CONTROL_PORT,
    dashboardView,
    onChange: pushShellState,
    log: (m) => console.log(m),
    // Google blocks sign-in inside the app: sign in in a Chrome window, the session is copied in
    onExternalLogin: async ({ account, site }) => {
      if (!fs.existsSync(WEBHUB_BIN)) return { ok: false, error: `${WEBHUB_BIN} not found` };
      const r = await runExec(WEBHUB_BIN, ['browser', 'login-external', site, '--account', account], 16 * 60 * 1000);
      if (!r.ok) console.error(`login-external ${site} [${account}]: ${r.stderr || r.stdout}`);
      return { ok: r.ok, error: (r.stderr || r.stdout).trim().split('\n').pop() };
    },
  });
  embedded.layout();
  if (EMBEDDED_ON) {
    embedded.start().catch((e) => console.error(`embedded browser control API not started: ${e.message}`));
  }
  mainWindow.webContents.on('did-finish-load', pushShellState);

  mainWindow.on('close', (e) => {
    if (!isQuitting) {
      e.preventDefault();
      mainWindow.hide(); // embedded pages keep running in the background
    }
  });

  connectDashboard();
}

function buildAppMenu() {
  const template = [
    {
      label: 'Web AI Hub',
      submenu: [
        { role: 'about', label: '关于 Web AI Hub' },
        { type: 'separator' },
        { label: '显示控制台窗口', accelerator: 'CmdOrCtrl+0', click: showMainWindow },
        { label: '隐藏窗口到菜单栏', accelerator: 'CmdOrCtrl+W', click: () => mainWindow?.hide() },
        { type: 'separator' },
        { role: 'hide', label: '隐藏 Web AI Hub' },
        { role: 'hideOthers', label: '隐藏其他' },
        { role: 'unhide', label: '全部显示' },
        { type: 'separator' },
        { label: '退出（保留后台服务）', accelerator: 'CmdOrCtrl+Q', click: () => { isQuitting = true; app.quit(); } },
      ],
    },
    {
      label: '编辑',
      submenu: [
        { role: 'undo', label: '撤销' },
        { role: 'redo', label: '重做' },
        { type: 'separator' },
        { role: 'cut', label: '剪切' },
        { role: 'copy', label: '拷贝' },
        { role: 'paste', label: '粘贴' },
        { role: 'selectAll', label: '全选' },
      ],
    },
    {
      label: '视图',
      submenu: [
        { label: '刷新看板', accelerator: 'CmdOrCtrl+R', click: () => { embedded?.select('dashboard'); dashboardView?.webContents.reload(); } },
        { label: '刷新当前页', accelerator: 'CmdOrCtrl+Shift+R', click: () => { const t = embedded?.tabs.get(embedded.selected); (t ? t.view : dashboardView)?.webContents.reload(); } },
        { type: 'separator' },
        { role: 'resetZoom', label: '实际大小' },
        { role: 'zoomIn', label: '放大' },
        { role: 'zoomOut', label: '缩小' },
        { type: 'separator' },
        { label: '开发者工具', accelerator: 'Alt+CmdOrCtrl+I', click: () => { const t = embedded?.tabs.get(embedded.selected); (t ? t.view : dashboardView)?.webContents.toggleDevTools(); } },
      ],
    },
    {
      label: '窗口',
      submenu: [
        { role: 'minimize', label: '最小化' },
        { role: 'zoom', label: '缩放' },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function renderTrayMenu(state) {
  if (!tray) return;
  let statusLine = `本地服务离线（127.0.0.1:${ADMIN_PORT}）`;
  let activeCount = 0;

  if (state) {
    const names = (state.browser?.accounts || state.accounts || []).map((a) => a.name || a).filter((n) => typeof n === 'string');
    if (names.length && names.join() !== accountNames.join()) { accountNames = names; pushShellState(); }
    const gRun = state.slots?.by_site?.gemini?.running?.length || 0;
    const gLim = state.slots?.by_site?.gemini?.limit || state.slots?.limit || 3;
    const cRun = state.slots?.by_site?.chatgpt?.running?.length || 0;
    const cLim = state.slots?.by_site?.chatgpt?.limit || state.slots?.limit || 3;
    const agRun = state.agents?.running ?? (state.agents?.recent || []).filter((a) => a.status === 'running').length;
    const agLim = state.agents?.max_running || 10;
    activeCount = (state.slots?.running?.length || 0) + agRun;
    statusLine = `在线 · Gemini ${gRun}/${gLim} · ChatGPT ${cRun}/${cLim} · 代理 ${agRun}/${agLim}`;
  }

  tray.setTitle(activeCount > 0 ? ` ⚡${activeCount}` : '');
  tray.setToolTip(`Web AI Hub\n${statusLine}`);

  const menu = Menu.buildFromTemplate([
    { label: statusLine, enabled: false },
    { type: 'separator' },
    { label: '显示控制台窗口', click: showMainWindow },
    { label: '在内嵌页打开 ChatGPT', enabled: !!embedded, click: () => openEmbedded('chatgpt') },
    { label: '在内嵌页打开 Gemini', enabled: !!embedded, click: () => openEmbedded('gemini') },
    {
      label: '唤出专用 Chrome 浏览器（外部模式）',
      click: async () => {
        if (fs.existsSync(WEBHUB_BIN)) await runExec(WEBHUB_BIN, ['browser', 'show'], 12000);
      },
    },
    {
      label: '打开 Gemini 网页',
      click: async () => {
        await apiPost('/api/browser/open', { site: 'gemini', activate: true, bring_to_front: true }).catch(() => {});
      },
    },
    {
      label: '打开 ChatGPT 网页',
      click: async () => {
        await apiPost('/api/browser/open', { site: 'chatgpt', activate: true, bring_to_front: true }).catch(() => {});
      },
    },
    { type: 'separator' },
    {
      label: '重启本地 MCP 服务',
      click: async () => {
        if (fs.existsSync(GWMCP_BIN)) await runExec(GWMCP_BIN, ['restart', 'server'], 20000);
        await refreshTray();
      },
    },
    {
      label: '打开日志文件夹',
      click: () => {
        fs.mkdirSync(LOGS_DIR, { recursive: true });
        shell.openPath(LOGS_DIR);
      },
    },
    { type: 'separator' },
    {
      label: '仅退出桌面应用（保留后台服务）',
      click: () => {
        isQuitting = true;
        app.quit();
      },
    },
    {
      label: '退出并停止所有后台服务',
      click: async () => {
        const { response } = await dialog.showMessageBox(mainWindow || undefined, {
          type: 'warning',
          buttons: ['停止服务并退出', '取消'],
          defaultId: 1,
          cancelId: 1,
          title: '确认停止后台服务',
          message: '停止后台服务会中断当前正在运行的 Web AI 和本地代理任务，确定继续吗？',
        });
        if (response === 0) {
          if (fs.existsSync(GWMCP_BIN)) await runExec(GWMCP_BIN, ['stop'], 20000);
          isQuitting = true;
          app.quit();
        }
      },
    },
  ]);
  tray.setContextMenu(menu);
}

async function refreshTray() {
  const st = await fetchState(1500);
  renderTrayMenu(st);
}

function createTray() {
  const trayPath = path.join(__dirname, 'build', 'trayTemplate.png');
  const img = nativeImage.createFromPath(trayPath);
  img.setTemplateImage(true);
  tray = new Tray(img);
  tray.on('double-click', showMainWindow);
  renderTrayMenu(null);
  refreshTray();
  pollTimer = setInterval(refreshTray, 5000);
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => showMainWindow());

  app.whenReady().then(() => {
    buildAppMenu();
    if (!HEADLESS_SHELL) createTray();
    createWindow();

    ipcMain.handle('desktop:retry-connect', () => connectDashboard());
    ipcMain.handle('desktop:start-and-reconnect', () => connectDashboard());
    ipcMain.handle('desktop:open-logs', () => {
      fs.mkdirSync(LOGS_DIR, { recursive: true });
      shell.openPath(LOGS_DIR);
    });
    ipcMain.handle('shell:state', () => ({ ...(embedded?.snapshot() || { tabs: [], selected: 'dashboard' }), accounts: accountNames }));
    ipcMain.handle('shell:select', (_e, id) => embedded?.select(String(id)));
    ipcMain.handle('shell:open', (_e, { site, account } = {}) => openEmbedded(site === 'gemini' ? 'gemini' : 'chatgpt', String(account || 'default')));
    ipcMain.handle('shell:close', (_e, id) => embedded?.closeTab(String(id)));
    ipcMain.handle('desktop:show-browser', async () => {
      if (fs.existsSync(WEBHUB_BIN)) await runExec(WEBHUB_BIN, ['browser', 'show'], 12000);
    });
  });

  app.on('activate', () => showMainWindow());
  app.on('before-quit', () => {
    isQuitting = true;
    for (const c of runningChildren) { try { c.kill('SIGTERM'); } catch { /* gone */ } } // the sign-in CLI closes its Chrome on TERM
    embedded?.stop();
    if (pollTimer) clearInterval(pollTimer);
  });
}
