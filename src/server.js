// Entry point: public listener (MCP + OAuth + read-only remote view) and the
// local admin listener (status page, live event stream, approvals, task API).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { loadConfig, loadSecrets, STATE_DIR, safeEqual, newId } from './config.js';
import { EventLog } from './events.js';
import { PathPolicy, PathError } from './paths.js';
import { JobManager } from './jobs.js';
import { TaskStore, Approvals } from './tasks.js';
import { OAuth } from './oauth.js';
import { registerTools, SERVER_INSTRUCTIONS } from './tools.js';
import { Slots } from './slots.js';
import { AgentManager } from './agents.js';
import { Safety } from './safety.js';
import { goalsSummary } from './goals.js';
import { listSwarms, swarmSummary, loadSwarm, createSwarm, startRunner, cancelSwarm } from './swarm.js';
import { dispatchRefusal, recordLimit, clearLimit, activeLimit, usedToday, SITE_NAMES, pickAccount } from './quota.js';
import { inspectTabs } from './browser-inspect.js';
import { resolveAccounts, getAccount, defaultAccountName, syncConfigFromDisk, upsertAccountInConfig, removeAccountFromConfig, setAccountEnabledInConfig, setDefaultAccountInConfig, cfgForAccount } from './accounts.js';
import { purgeAccountLogin, withLoginLock } from './login-external.js';
import { ensureDedicated, stopDedicated, openTab, focusTab, closeTab, closeTaskTabsFor, findTargetAccount, pidAlive, monitorUrl, LOGIN_URLS } from './browser.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const VERSION = JSON.parse(fs.readFileSync(path.join(HERE, '..', 'package.json'), 'utf8')).version;

const cfg = loadConfig();
const secrets = loadSecrets();
const events = new EventLog(path.join(STATE_DIR, 'logs'));
const paths = new PathPolicy(cfg);
const jobs = new JobManager(cfg, paths.roots, events);
const tasks = new TaskStore(path.join(STATE_DIR, 'tasks'), events);
const approvals = new Approvals(cfg, events);
const oauth = new OAuth(cfg, secrets, events);
const slots = new Slots(cfg, tasks, events);
const agents = new AgentManager(cfg, paths, events, approvals);
const safety = new Safety(cfg, paths, events);
const inFlight = new Map();
const ctx = { cfg, paths, events, tasks, jobs, approvals, agents, safety, inFlight };

const clients = new Map(); // client_id -> { name, last_seen, requests, last_method, ua }
const started = new Date().toISOString();

// ---------- helpers ----------
function send(res, status, body, headers = {}) {
  const isStr = typeof body === 'string';
  res.writeHead(status, { 'content-type': isStr ? 'text/plain; charset=utf-8' : 'application/json', 'cache-control': 'no-store', ...headers });
  res.end(isStr ? body : JSON.stringify(body));
}
function html(res, body, headers = {}) { send(res, 200, body, { 'content-type': 'text/html; charset=utf-8', ...headers }); }

async function readBody(req, limit = 12 * 1024 * 1024) {
  const chunks = []; let n = 0;
  for await (const c of req) { n += c.length; if (n > limit) throw Object.assign(new Error('body too large'), { status: 413 }); chunks.push(c); }
  const raw = Buffer.concat(chunks).toString('utf8');
  const ct = req.headers['content-type'] || '';
  if (!raw) return {};
  if (ct.includes('application/json')) return JSON.parse(raw);
  if (ct.includes('application/x-www-form-urlencoded')) return Object.fromEntries(new URLSearchParams(raw));
  try { return JSON.parse(raw); } catch { return Object.fromEntries(new URLSearchParams(raw)); }
}

function hostOk(host) {
  if (!host) return false;
  const h = host.replace(/:\d+$/, '').toLowerCase();
  if (['localhost', '127.0.0.1', '[::1]'].includes(h)) return true;
  if (cfg.public_base_url) { try { if (new URL(cfg.public_base_url).hostname === h) return true; } catch { /* */ } }
  return (cfg.public_host_suffixes || []).some((s) => h.endsWith(s));
}

function baseUrl(req) {
  if (cfg.public_base_url) return cfg.public_base_url.replace(/\/$/, '');
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  const local = /^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host);
  const proto = req.headers['x-forwarded-proto'] || (local ? 'http' : 'https');
  return `${proto}://${host}`;
}

function cookies(req) {
  return Object.fromEntries((req.headers.cookie || '').split(';').map((c) => c.trim().split('=')).filter((x) => x[0]).map(([k, ...v]) => [k, decodeURIComponent(v.join('='))]));
}
function signView(exp) { return `${exp}.${crypto.createHmac('sha256', secrets.view_cookie_key).update(String(exp)).digest('base64url')}`; }
function viewAuthed(req) {
  const v = cookies(req).gwm_view; if (!v) return false;
  const [exp] = v.split('.');
  return Number(exp) > Date.now() && safeEqual(v, signView(exp));
}

// Latest /authorize URL (admin API only): lets a local automation finish the consent step
// in its own tab when the client opened the consent page in a popup it cannot reach.
let lastAuthorize = null;

// ---------- state snapshot ----------
let browserCache = { at: 0, data: null };

async function getBrowserSnapshot(probe = false, account = null) {
  syncConfigFromDisk(cfg);
  if (!probe && !account && browserCache.data && Date.now() - browserCache.at < 1000) return browserCache.data;
  const data = await inspectTabs(cfg, tasks, { probe, account }).catch(() => ({
    running: false, mode: 'down', cdp_url: cfg.gemweb.cdp_url, tab_count: 0, site_counts: {}, tabs: [], accounts: [],
  }));
  if (!probe && !account) browserCache = { at: Date.now(), data };
  return data;
}

function buildAccountsSummary(browserSnap = null, { remote = false } = {}) {
  const accts = resolveAccounts(cfg);
  const allTasks = tasks.list();
  const sl = slots.summary();
  const brByName = new Map((browserSnap?.accounts || []).map((b) => [b.account, b]));
  return accts.map((a) => {
    const br = brByName.get(a.name);
    const quota = Object.fromEntries(SITE_NAMES.map((s) => [s, {
      supported: a.sites.includes(s),
      used_today: usedToday(allTasks, new Date(), s, a.name),
      daily_limit: a.daily_limit,
      limit: activeLimit(Date.now(), s, a.name),
      running: sl.by_account?.[a.name]?.[s]?.running || [],
      queued: sl.by_account?.[a.name]?.[s]?.queued || [],
      concurrency: a.concurrency,
    }]));
    const rec = {
      name: a.name,
      label: a.label,
      enabled: a.enabled,
      is_default: a.is_default,
      sites: a.sites,
      cdp_url: a.cdp_url,
      port: a.port,
      concurrency: a.concurrency,
      daily_limit: a.daily_limit,
      min_interval_sec: a.min_interval_sec,
      headless: a.headless,
      browser: br ? {
        running: br.running,
        mode: br.mode,
        port: br.port ?? a.port, // the browser actually in use (embedded app: its CDP port, not the dedicated Chrome's)
        tab_count: br.tab_count,
        browser_version: br.browser_version,
        ...(remote ? {} : { pid: br.pid }),
      } : null,
      quota,
    };
    if (!remote) rec.profile_dir = a.profile_dir;
    return rec;
  });
}

function stateSnapshot() {
  syncConfigFromDisk(cfg);
  const now = Date.now();
  let tunnel = null;
  try { tunnel = fs.readFileSync(path.join(STATE_DIR, 'run', 'tunnel-url'), 'utf8').trim(); } catch { /* none */ }
  const allJobs = jobs.list();
  const allTasks = tasks.list();
  const defAcct = defaultAccountName(cfg);
  const accts = resolveAccounts(cfg);
  const by_account = Object.fromEntries(accts.map((a) => [a.name, {
    label: a.label,
    enabled: a.enabled,
    is_default: a.is_default,
    sites: a.sites,
    daily_limit: a.daily_limit,
    concurrency: a.concurrency,
    ...Object.fromEntries(SITE_NAMES.map((s) => [s, {
      used_today: usedToday(allTasks, new Date(), s, a.name),
      limit: activeLimit(now, s, a.name),
    }])),
  }]));
  return {
    server: { version: VERSION, started, pid: process.pid, roots: paths.roots.map((r) => ({ name: r.name, path: r.path })), dangerous_policy: cfg.dangerous_policy, sandbox: cfg.sandbox },
    tunnel: { url: tunnel || cfg.public_base_url || null, mcp_url: (tunnel || cfg.public_base_url) ? `${(tunnel || cfg.public_base_url).replace(/\/$/, '')}/mcp` : null },
    clients: [...clients.entries()].map(([id, c]) => ({ id, ...c, idle_sec: Math.round((now - c.last_seen) / 1000) })),
    oauth_clients: oauth.summary(),
    tasks: allTasks.slice(0, 200).map(({ prompt, files_seen, ...t }) => ({ ...t, prompt_preview: (prompt || '').slice(0, 300) })),
    pending: approvals.list(),
    slots: slots.summary(),
    in_flight: [...inFlight.values()].map((x) => ({ ...x, elapsed_sec: Math.round((now - x.started_ms) / 100) / 10 })),
    jobs: { running: allJobs.filter((j) => j.running), recent: allJobs.slice(0, 30) },
    goals: (() => { try { return goalsSummary(); } catch { return []; } })(),
    swarms: (() => { try { const all = listSwarms(); return [...all.filter((x) => x.status === 'running'), ...all.filter((x) => x.status !== 'running').slice(0, 5)].map((x) => swarmSummary(x)); } catch { return []; } })(),
    agents: {
      ...agents.limits(),
      recent: agents.list(20),
      // running agents with pid, prompt and a live stdout tail (for the dashboard's "running now" cards)
      active: agents.running().map((a) => { const s = agents.status(a); return { id: a.id, backend: a.backend, status: a.status, task_id: a.task_id, cwd: a.cwd, pid: a.pid, started: a.started, deadline: a.deadline, prompt_preview: a.prompt_preview, stdout_tail: s.stdout_tail || '', stdout_bytes: s.stdout_bytes }; }),
    },
    web: {
      default_account: defAcct,
      auto_failover: cfg.gemweb?.auto_failover !== false,
      limit: activeLimit(now, 'gemini', defAcct),
      used_today: usedToday(allTasks),
      sites: Object.fromEntries(SITE_NAMES.map((s) => [s, {
        used_today: usedToday(allTasks, new Date(), s),
        limit: activeLimit(now, s, defAcct),
      }])),
      by_account,
      daily_limit: Number(cfg.gemweb.daily_limit ?? 30),
      browser: cfg.gemweb.browser,
      headless: cfg.gemweb.headless === true,
      owner_chrome_fallback: !!cfg.gemweb.owner_chrome_fallback,
    },
    seq: events.seq,
  };
}

async function stateSnapshotAsync({ probe = false, remote = false } = {}) {
  const base = stateSnapshot();
  const b = await getBrowserSnapshot(probe);
  const accounts = buildAccountsSummary(b, { remote });
  if (remote) {
    const { profile_dir, pid, ...safeBrowser } = b;
    if (Array.isArray(safeBrowser.accounts)) {
      safeBrowser.accounts = safeBrowser.accounts.map(({ profile_dir: _pd, pid: _pid, ...rest }) => rest);
    }
    return { ...base, browser: safeBrowser, accounts };
  }
  return { ...base, browser: b, accounts };
}

// ---------- SSE ----------
function sse(req, res, filterTask) {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive', 'x-accel-buffering': 'no' });
  const url = new URL(req.url, 'http://x');
  const since = Number(url.searchParams.get('since') || req.headers['last-event-id'] || 0);
  const backlog = Number(url.searchParams.get('backlog') || 3000);
  const write = (ev) => res.write(`id: ${ev.seq}\ndata: ${JSON.stringify(ev)}\n\n`);
  for (const ev of events.query({ task_id: filterTask, since, limit: backlog })) write(ev);
  res.write(`event: ready\ndata: {"seq":${events.seq}}\n\n`);
  const unsub = events.subscribe((ev) => { if (!filterTask || ev.task_id === filterTask) write(ev); });
  const ka = setInterval(() => res.write(': ka\n\n'), 15000);
  req.on('close', () => { unsub(); clearInterval(ka); });
}

const UI_PATH = path.join(HERE, 'ui', 'status.html');
function uiPage(opts) {
  const page = fs.readFileSync(UI_PATH, 'utf8');
  return page.replace('/*__GWM_BOOT__*/', `window.GWM=${JSON.stringify(opts)};`);
}

// ---------- MCP ----------
async function handleMcp(req, res, body, auth) {
  const ua = String(req.headers['user-agent'] || '').slice(0, 120);
  const c = clients.get(auth.client_id) || { name: auth.client_name, requests: 0, first_seen: Date.now() };
  c.last_seen = Date.now(); c.requests++; c.ua = ua;
  const msgs = Array.isArray(body) ? body : [body];
  c.last_method = msgs.map((m) => m?.method).filter(Boolean).join(',') || req.method;
  clients.set(auth.client_id, c);
  for (const m of msgs) {
    if (m?.method && m.method !== 'tools/call') {
      events.emit('mcp.request', { method: m.method, client: auth.client_name, client_id: auth.client_id, ua, protocol: m.params?.protocolVersion, client_info: m.params?.clientInfo });
    }
  }
  const server = new McpServer({ name: 'local-projects', title: 'Local Projects', version: VERSION }, { instructions: SERVER_INSTRUCTIONS });
  registerTools(server, ctx, { client: auth.client_name, client_id: auth.client_id });
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true }); // plain JSON: Gemini's chat-side MCP client ignores SSE tool results
  res.on('close', () => { transport.close(); server.close(); });
  await server.connect(transport);
  req.auth = { token: 'x', clientId: auth.client_id, scopes: ['mcp'] };
  await transport.handleRequest(req, res, body);
}

// ---------- public listener ----------
const publicServer = http.createServer(async (req, res) => {
  try {
    if (!hostOk(req.headers.host)) return send(res, 421, 'unknown host');
    const url = new URL(req.url, 'http://x');
    const p = url.pathname;
    const base = baseUrl(req);
    res.setHeader('access-control-allow-origin', '*');
    res.setHeader('access-control-allow-headers', 'authorization, content-type, mcp-protocol-version, mcp-session-id, last-event-id');
    res.setHeader('access-control-expose-headers', 'mcp-session-id, www-authenticate');
    if (req.method === 'OPTIONS') { res.writeHead(204, { 'access-control-allow-methods': 'GET, POST, DELETE, OPTIONS' }); return res.end(); }

    if (p.startsWith('/.well-known/oauth-protected-resource')) return send(res, 200, oauth.resourceMetadata(base));
    if (p.startsWith('/.well-known/oauth-authorization-server') || p.startsWith('/.well-known/openid-configuration')) return send(res, 200, oauth.metadata(base));
    if (p === '/register' && req.method === 'POST') { const r = oauth.register(await readBody(req)); return send(res, r.status, r.body); }
    if (p === '/authorize' && req.method === 'GET') {
      const q = Object.fromEntries(url.searchParams);
      const chk = oauth.checkAuthorize(q);
      if (chk.error) return send(res, 400, `Authorization error: ${chk.error}`);
      events.emit('auth.consent_shown', { client_id: q.client_id, client_name: chk.client.client_name, redirect_host: (() => { try { return new URL(q.redirect_uri).host; } catch { return ''; } })(), ua: String(req.headers['user-agent'] || '').slice(0, 120) });
      lastAuthorize = { at: Date.now(), url: `${base}/authorize?${url.searchParams}` };
      return html(res, oauth.consentPage(q, chk.client), { 'x-frame-options': 'DENY' });
    }
    if (p === '/authorize' && req.method === 'POST') {
      const r = oauth.approve({ ...(await readBody(req)), iss_base: base });
      if (r.error) return send(res, 400, `Authorization error: ${r.error}`);
      if (r.page) return html(res, r.page, { 'x-frame-options': 'DENY' });
      res.writeHead(302, { location: r.redirect }); return res.end();
    }
    if (p === '/token' && req.method === 'POST') {
      const b = await readBody(req);
      const r = oauth.token(req, b);
      if (r.status !== 200) events.emit('auth.token_failed', { status: r.status, error: r.body?.error, detail: r.body?.error_description, grant_type: b.grant_type, client_id: b.client_id || '(basic)', ua: String(req.headers['user-agent'] || '').slice(0, 120) });
      return send(res, r.status, r.body);
    }

    if (p === '/mcp' || p === '/mcp/') {
      const auth = oauth.verify(req, base);
      if (!auth) {
        events.emit('auth.unauthorized', { path: p, method: req.method, has_token: !!req.headers.authorization, ua: String(req.headers['user-agent'] || '').slice(0, 120) });
        return send(res, 401, { error: 'invalid_token', error_description: 'Bearer token required' }, { 'www-authenticate': `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource"` });
      }
      const body = req.method === 'POST' ? await readBody(req) : undefined;
      return await handleMcp(req, res, body, auth);
    }

    if (p === '/health') return send(res, 200, { ok: true, version: VERSION });

    // Remote read-only status view (phone). Passcode login -> signed cookie.
    if (p.startsWith('/view')) {
      if (!cfg.remote_view) return send(res, 404, 'remote view disabled');
      res.setHeader('x-frame-options', 'DENY');
      if (p === '/view/login' && req.method === 'POST') {
        const form = await readBody(req);
        if (oauth.fails.filter((t) => Date.now() - t < 15 * 60 * 1000).length >= 8) return send(res, 429, 'too many attempts');
        if (!safeEqual(form.passcode, secrets.passcode)) { oauth.fails.push(Date.now()); events.emit('auth.rejected', { stage: 'view-login', reason: 'wrong passcode' }); res.writeHead(302, { location: '/view?bad=1' }); return res.end(); }
        const exp = Date.now() + 14 * 24 * 3600 * 1000;
        res.writeHead(302, { location: '/view', 'set-cookie': `gwm_view=${encodeURIComponent(signView(exp))}; Path=/view; HttpOnly; Secure; SameSite=Strict; Max-Age=${14 * 24 * 3600}` });
        return res.end();
      }
      if (!viewAuthed(req)) {
        if (p.startsWith('/view/api')) return send(res, 401, { error: 'login required' });
        return html(res, loginPage(url.searchParams.get('bad')));
      }
      if (p === '/view' || p === '/view/') return html(res, uiPage({ api: '/view/api', readOnly: !cfg.remote_approve, remote: true, csrf: cfg.remote_approve ? signView('csrf') : '' }));
      if (p === '/view/api/state') return send(res, 200, await stateSnapshotAsync({ probe: false, remote: true }));
      if (p === '/view/api/stream') return sse(req, res, url.searchParams.get('task_id') || undefined);
      if (p === '/view/api/events') return send(res, 200, events.query({ task_id: url.searchParams.get('task_id') || undefined, since: Number(url.searchParams.get('since') || 0) }));
      if (cfg.remote_approve && p.startsWith('/view/api/confirm/') && req.method === 'POST') {
        if (!safeEqual(req.headers['x-gwm-csrf'], signView('csrf'))) return send(res, 403, 'csrf');
        const body = await readBody(req);
        return send(res, 200, { ok: approvals.decide(p.split('/').pop(), !!body.approve, 'remote-view') });
      }
      return send(res, 404, 'not found');
    }
    if (p === '/') return send(res, 200, 'Local Projects MCP server. MCP endpoint: /mcp');
    return send(res, 404, 'not found');
  } catch (e) {
    console.error('public error', e);
    if (!res.headersSent) send(res, e.status || 500, { error: e.message });
  }
});

function loginPage(bad) {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>网页 AI 控制台登录</title>
<style>:root{color-scheme:light dark}body{margin:0;font:16px -apple-system,"PingFang SC",system-ui,sans-serif;background:#0f1115;color:#e6e6e6;display:flex;min-height:100vh;align-items:center;justify-content:center;padding:16px;box-sizing:border-box}
@media (prefers-color-scheme: light){body{background:#f6f7f9;color:#1d1f23}}form{width:100%;max-width:360px}input,button{width:100%;box-sizing:border-box;padding:12px;border-radius:10px;font-size:16px;margin-top:10px}
input{border:1px solid #8886;background:transparent;color:inherit}button{border:0;background:#2856d6;color:#fff}.e{color:#f7768e}</style></head>
<body><form method="post" action="/view/login"><h2>网页 AI 控制台</h2>${bad ? '<p class="e">访问口令错误</p>' : ''}<input type="password" name="passcode" placeholder="请输入访问口令" autofocus required><button>进入控制台</button></form></body></html>`;
}

// ---------- direct dispatch from the dashboard (POST /api/dispatch) ----------
const WEBHUB_BIN = path.join(HERE, '..', 'bin', 'webhub.mjs');
const BLOCKED_429 = /limit|cap|quota|rate|cooldown|busy|full/i;

function resolveDispatchCwd(cwd) {
  const { abs } = paths.resolve(String(cwd)); // throws PathError outside the roots
  if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) return { error: `cwd is not a directory: ${abs}` };
  return { abs };
}

// Starts `webhub run --no-wait` for one web task and returns its task id (or why it was refused).
function spawnWebDispatch({ site, prompt, cwd, account, model, chatUrl, allowPro }) {
  fs.mkdirSync(path.join(STATE_DIR, 'run'), { recursive: true, mode: 0o700 });
  const promptFile = path.join(STATE_DIR, 'run', `ui-prompt-${newId('p', 4)}.txt`);
  fs.writeFileSync(promptFile, prompt, { mode: 0o600 });
  const args = ['run', '--site', site, '--no-operator', '--no-wait', '--from', 'ui', '-f', promptFile];
  if (cwd) args.push('--cwd', cwd);
  if (account) args.push('--account', account);
  if (model) args.push('--model', model);
  if (chatUrl) args.push('--chat', chatUrl);
  if (allowPro === true) args.push('--allow-pro');
  return new Promise((resolve) => {
    let out = '', err = '', done = false, exited = false;
    const child = spawn(process.execPath, [WEBHUB_BIN, ...args], { detached: true, stdio: ['ignore', 'pipe', 'pipe'], env: process.env });
    const cleanup = () => { fs.rm(promptFile, { force: true }, () => {}); };
    const finish = (r) => {
      if (done) {
        // The request was already answered "202 still starting"; a later refusal would be lost.
        if (r.body?.ok === false) events.emit('dispatch.failed', { site, status: r.status, kind: r.body.kind, error: r.body.error, text: `${site} dispatch failed after it was accepted: ${r.body.error}` });
        return;
      }
      done = true; clearTimeout(timer);
      // keep draining the pipes until the child exits (closing them early could EPIPE it), but don't hold the server
      child.unref(); child.stdout?.unref?.(); child.stderr?.unref?.();
      resolve(r);
    };
    const taskId = () => (/TASK_ID=(\S+)/.exec(err) || /TASK_ID=(\S+)/.exec(out) || /^(t_[0-9a-f]{6,})\s*$/m.exec(out))?.[1] || null;
    const onData = () => { const id = taskId(); if (id) finish({ status: 200, body: { ok: true, mode: 'web', site, task_id: id } }); };
    child.stdout.on('data', (d) => { out += d; onData(); });
    child.stderr.on('data', (d) => { err += d; onData(); });
    child.on('error', (e) => { cleanup(); finish({ status: 500, body: { ok: false, error: `could not start webhub: ${e.message}` } }); });
    child.on('exit', (code) => {
      exited = true; cleanup();
      const id = taskId();
      if (code === 0 && id) return finish({ status: 200, body: { ok: true, mode: 'web', site, task_id: id } });
      if (id) return finish({ status: 200, body: { ok: true, mode: 'web', site, task_id: id } });
      const blocked = /BLOCKED: ([^|\n]*)\|([^\n]*)/.exec(out);
      if (blocked) return finish({ status: BLOCKED_429.test(blocked[1]) ? 429 : 400, body: { ok: false, kind: blocked[1].trim(), error: blocked[2].trim() || blocked[1].trim() } });
      const msg = (err.split('\n').map((l) => l.trim()).filter(Boolean).pop() || out.trim().split('\n').pop() || `webhub exited with code ${code}`).replace(/^webhub:\s*/, '');
      finish({ status: BLOCKED_429.test(msg) ? 429 : 400, body: { ok: false, error: msg.slice(0, 500), exit_code: code } });
    });
    // `webhub run --no-wait` normally returns within a second; don't hold the request longer than this
    const timer = setTimeout(() => {
      if (!exited) finish({ status: 202, body: { ok: true, mode: 'web', site, task_id: null, pending: true, note: 'dispatch still starting; the task will appear in the list shortly' } });
    }, 3500);
  });
}

async function handleDispatch(b) {
  const prompt = typeof b.prompt === 'string' ? b.prompt : '';
  if (!prompt.trim()) return { status: 400, body: { error: 'prompt required' } };
  const backend = b.backend ? String(b.backend).trim() : '';
  const mode = b.target === 'web' ? 'web' : (b.target === 'agent' || backend) ? 'agent' : 'web';
  const str = (v, max = 400) => (v == null ? '' : String(v).trim().slice(0, max));
  if (mode === 'web') {
    const site = b.site == null || b.site === '' ? 'chatgpt' : String(b.site);
    if (!['gemini', 'chatgpt'].includes(site)) return { status: 400, body: { ok: false, error: 'site must be gemini or chatgpt' } };
    let cwd = null;
    if (str(b.cwd)) {
      try {
        const r = resolveDispatchCwd(b.cwd);
        if (r.error) return { status: 400, body: { ok: false, error: r.error } };
        cwd = r.abs;
      } catch (e) {
        if (e instanceof PathError) return { status: 403, body: { ok: false, error: e.message } };
        throw e;
      }
    }
    const account = str(b.account, 60);
    if (account && !/^[\w.-]+$/.test(account)) return { status: 400, body: { ok: false, error: 'invalid account name' } };
    const chatUrl = str(b.chat_url, 2000);
    if (chatUrl && !/^https:\/\//i.test(chatUrl)) return { status: 400, body: { ok: false, error: 'chat_url must be an https:// conversation link' } };
    return spawnWebDispatch({ site, prompt, cwd, account: account || null, model: str(b.model, 120) || null, chatUrl: chatUrl || null, allowPro: b.allow_pro === true });
  }
  if (!ctx.agents) return { status: 503, body: { ok: false, error: 'local agents are not available on this server' } };
  const targetCwd = str(b.cwd) || paths.roots.find((r) => fs.existsSync(r.path))?.path;
  if (!targetCwd) return { status: 400, body: { ok: false, error: 'no working directory given and no allowed root exists' } };
  let r;
  try {
    r = await agents.spawn({ backend: backend || undefined, prompt, cwd: targetCwd, timeout_min: b.timeout_min, task_id: str(b.task_id, 60) || 'ui_dispatch', model: str(b.model, 160) || undefined, effort: str(b.effort, 40) || undefined, account: str(b.account, 60) || undefined, chat_url: str(b.chat_url, 2000) || undefined });
  } catch (e) {
    if (e instanceof PathError) return { status: 403, body: { ok: false, error: e.message } };
    throw e;
  }
  if (r.error) return { status: r.denied ? 403 : 400, body: { ok: false, error: r.error } };
  return { status: 200, body: { ok: true, mode: 'agent', agent_id: r.agent.id, backend: r.agent.backend, status: r.agent.status, cwd: r.agent.cwd } };
}

// ---------- admin listener ----------
const ADMIN_UI_TOKEN = crypto.randomBytes(24).toString('base64url'); // embedded in the page; cross-origin pages cannot read it

function adminAuthorized(req) {
  const h = req.headers.authorization || '';
  if (h.startsWith('Bearer ') && safeEqual(h.slice(7).trim(), secrets.admin_token)) return true;
  return safeEqual(req.headers['x-gwm-csrf'], ADMIN_UI_TOKEN);
}

const adminServer = http.createServer(async (req, res) => {
  try {
    const host = (req.headers.host || '').replace(/:\d+$/, '');
    if (!['127.0.0.1', 'localhost', cfg.admin_host].includes(host)) return send(res, 421, 'bad host'); // DNS-rebinding guard
    const url = new URL(req.url, 'http://x');
    const p = url.pathname;
    if (p === '/' || p === '/index.html') return html(res, uiPage({ api: '/api', readOnly: false, remote: false, csrf: ADMIN_UI_TOKEN }));
    // Reads are open on the loopback listener (same machine); writes need the page token or admin token.
    if (p === '/api/state' && req.method === 'GET') return send(res, 200, await stateSnapshotAsync({ probe: url.searchParams.get('probe') === '1', remote: false }));
    if (p === '/api/accounts' && req.method === 'GET') {
      syncConfigFromDisk(cfg);
      const b = await getBrowserSnapshot(false);
      return send(res, 200, { default_account: defaultAccountName(cfg), auto_failover: cfg.gemweb?.auto_failover !== false, accounts: buildAccountsSummary(b) });
    }
    if (p === '/api/browser/tabs' && req.method === 'GET') return send(res, 200, await getBrowserSnapshot(url.searchParams.get('probe') === '1', url.searchParams.get('account') || null));
    if (p === '/api/jobs' && req.method === 'GET') return send(res, 200, jobs.list());
    if (p === '/api/swarms' && req.method === 'GET') return send(res, 200, listSwarms().slice(0, 50).map((x) => swarmSummary(x)));
    if (/^\/api\/swarms\/sw_[0-9a-f]+$/.test(p) && req.method === 'GET') { const st = loadSwarm(p.split('/')[3]); return st ? send(res, 200, swarmSummary(st, { answers: url.searchParams.get('answers') === '1' })) : send(res, 404, { error: 'no such swarm' }); }
    if (p === '/api/oauth/last-authorize') return adminAuthorized(req) ? send(res, 200, lastAuthorize || {}) : send(res, 401, { error: 'admin token required' });
    if (p === '/api/stream') return sse(req, res, url.searchParams.get('task_id') || undefined);
    if (p === '/api/events') return send(res, 200, events.query({ task_id: url.searchParams.get('task_id') || undefined, since: Number(url.searchParams.get('since') || 0), limit: Number(url.searchParams.get('limit') || 5000) }));
    if (p.startsWith('/api/tasks/') && req.method === 'GET' && p.split('/').length === 4) {
      const t = tasks.get(p.split('/')[3]); if (!t) return send(res, 404, { error: 'no such task' });
      const { files_seen, ...rest } = t; return send(res, 200, rest);
    }
    if (p === '/api/tasks' && req.method === 'GET') return send(res, 200, stateSnapshot().tasks);
    if (!['POST', 'DELETE'].includes(req.method) && !(p.endsWith('/wait') && req.method === 'GET')) return send(res, 404, 'not found');
    if (!adminAuthorized(req)) return send(res, 403, { error: 'admin token required' });

    if (req.method === 'DELETE') {
      const mDel = /^\/api\/accounts\/([^/]+)$/.exec(p);
      if (!mDel) return send(res, 404, 'not found');
      const acctName = decodeURIComponent(mDel[1]);
      syncConfigFromDisk(cfg);
      const acct = getAccount(cfg, acctName);
      const sl = slots.summary().by_account?.[acct.name];
      const busy = [...(sl?.gemini?.running || []), ...(sl?.chatgpt?.running || [])];
      if (busy.length && url.searchParams.get('force') !== '1') {
        return send(res, 409, { error: `account "${acct.name}" has running tasks (${busy.join(', ')})` });
      }
      const doRemove = async () => {
        await stopDedicated(cfgForAccount(cfg, acct.name), acct.name).catch(() => {});
        const removed = removeAccountFromConfig(cfg, acct.name);
        if (url.searchParams.get('purge') === '1' && removed.profile_dir) fs.rmSync(removed.profile_dir, { recursive: true, force: true });
        const purged = url.searchParams.get('purge') === '1' ? await purgeAccountLogin(cfg, removed.name, { locked: url.searchParams.get('purge') === '1' }).catch((e) => ({ profile: false, partition: false, error: e.message })) : null;
        return { removed, purged };
      };
      // removal (like a re-bind) holds the sign-in lock for its whole run: a sign-in cannot start in the middle of it,
      // and a running one makes this fail with 409 before anything is touched
      let out;
      try { out = await withLoginLock(cfg, { account: acct.name, purge: url.searchParams.get('purge') === '1' }, doRemove); } catch (e) { if (e.status === 409) return send(res, 409, { error: e.message }); throw e; }
      const { removed, purged } = out;
      browserCache.at = 0;
      events.emit('account.removed', { account: removed.name });
      return send(res, 200, { ok: true, account: removed.name, ...(purged ? { purged } : {}) });
    }

    if (p === '/api/dispatch') {
      if (req.method !== 'POST') return send(res, 405, { error: 'POST required' });
      const r = await handleDispatch(await readBody(req));
      return send(res, r.status, r.body);
    }
    if (p === '/api/accounts') {
      const b = await readBody(req);
      // changing what an account is bound to (port / profile) waits out a running sign-in or import-login, never races it
      let acct;
      try { acct = await withLoginLock(cfg, { account: String(b.name || '').toLowerCase(), site: 'account-edit' }, async () => { syncConfigFromDisk(cfg); return upsertAccountInConfig(cfg, b.name, b); }); } catch (e) { if (e.status === 409) return send(res, 409, { error: e.message }); throw e; }
      browserCache.at = 0;
      events.emit('account.saved', { account: acct.name, cdp_url: acct.cdp_url, sites: acct.sites });
      return send(res, 200, { ok: true, account: acct });
    }
    if (p === '/api/accounts/default') {
      const b = await readBody(req);
      const acct = setDefaultAccountInConfig(cfg, b.name);
      events.emit('account.default', { account: acct.name });
      return send(res, 200, { ok: true, default_account: acct.name });
    }
    const mTog = /^\/api\/accounts\/([^/]+)\/toggle$/.exec(p);
    if (mTog) {
      const b = await readBody(req);
      const acct = setAccountEnabledInConfig(cfg, decodeURIComponent(mTog[1]), b.enabled !== false);
      events.emit('account.toggled', { account: acct.name, enabled: acct.enabled });
      return send(res, 200, { ok: true, account: acct });
    }

    if (p.startsWith('/api/jobs/') && p.endsWith('/kill')) {
      const id = p.split('/')[3];
      const ok = jobs.kill(id);
      if (ok) events.emit('job.killed', { job_id: id, by: 'admin' });
      return send(res, ok ? 200 : 404, { ok, job_id: id });
    }
    if (p.startsWith('/api/agents/') && p.endsWith('/stop')) {
      const id = p.split('/')[3];
      const ok = agents.stop(id);
      return send(res, ok ? 200 : 404, { ok, agent_id: id });
    }
    if (p === '/api/browser/start') {
      syncConfigFromDisk(cfg);
      const b = await readBody(req);
      const acct = getAccount(cfg, b.account || null);
      const scfg = cfgForAccount(cfg, acct.name);
      await ensureDedicated(scfg, () => {}, { ensureMonitorTab: scfg.gemweb?.headless !== true, account: acct.name });
      browserCache.at = 0;
      return send(res, 200, await getBrowserSnapshot(false));
    }
    if (p === '/api/browser/stop') {
      syncConfigFromDisk(cfg);
      const b = await readBody(req);
      const acct = getAccount(cfg, b.account || null);
      const sl = slots.summary().by_account?.[acct.name];
      const busy = [...(sl?.gemini?.running || []), ...(sl?.chatgpt?.running || [])];
      if (busy.length && !b.force) {
        return send(res, 409, { error: `account "${acct.name}" has running tasks (${busy.join(', ')})` });
      }
      const resStop = await stopDedicated(cfgForAccount(cfg, acct.name), acct.name);
      browserCache.at = 0;
      return send(res, 200, { ok: true, ...resStop });
    }
    if (p === '/api/browser/open') {
      syncConfigFromDisk(cfg);
      const b = await readBody(req);
      const acct = getAccount(cfg, b.account || null);
      const scfg = cfgForAccount(cfg, acct.name);
      let dest = b.url;
      if (!dest) {
        if (b.site === 'gemini') dest = scfg.gemweb.gemini_url || LOGIN_URLS.gemini;
        else if (b.site === 'chatgpt') dest = scfg.gemweb.chatgpt?.url || LOGIN_URLS.chatgpt;
        else if (b.site === 'monitor') dest = monitorUrl(scfg, acct.name);
      }
      if (!dest || !/^https?:\/\//i.test(String(dest))) return send(res, 400, { error: 'valid site or http(s) url required' });
      const resTab = await openTab(scfg, dest, { activate: b.activate !== false, bringToFront: b.bring_to_front !== false && scfg.gemweb?.headless !== true, account: acct.name });
      browserCache.at = 0;
      return send(res, 200, { ok: true, ...resTab });
    }
    if (p === '/api/browser/focus') {
      syncConfigFromDisk(cfg);
      const b = await readBody(req);
      if (!b.target_id) return send(res, 400, { error: 'target_id required' });
      const acctName = b.account || await findTargetAccount(cfg, b.target_id) || defaultAccountName(cfg);
      const ok = await focusTab(cfgForAccount(cfg, acctName), b.target_id, { bringToFront: b.bring_to_front !== false, account: acctName });
      return send(res, ok ? 200 : 404, { ok });
    }
    if (p === '/api/browser/close') {
      syncConfigFromDisk(cfg);
      const b = await readBody(req);
      if (!b.target_id) return send(res, 400, { error: 'target_id required' });
      const acctName = b.account || await findTargetAccount(cfg, b.target_id) || defaultAccountName(cfg);
      const ok = await closeTab(cfgForAccount(cfg, acctName), b.target_id, { account: acctName });
      browserCache.at = 0;
      return send(res, ok ? 200 : 404, { ok });
    }

    if (p === '/api/swarms/event') { // from a swarm runner
      const { swarm_id, type, ...rest } = await readBody(req);
      if (!/^sw_[0-9a-f]{6,16}$/.test(String(swarm_id)) || !/^swarm\.[\w.]+$/.test(String(type))) return send(res, 400, { error: 'swarm_id and swarm.* type required' });
      events.emit(type, { task_id: `swarm:${swarm_id}`, swarm_id, ...rest });
      return send(res, 200, { ok: true });
    }
    if (p === '/api/swarms') { // start a swarm from a plan (same as `webhub swarm start`)
      const b = await readBody(req);
      try { const st = createSwarm(b.plan || b, cfg, { from: b.from || 'api' }); startRunner(st.id); return send(res, 200, { ok: true, swarm_id: st.id, tasks: st.tasks.length }); } catch (e) { return send(res, e.usage ? 400 : e.denied ? 429 : 500, { ok: false, error: e.message }); }
    }
    if (/^\/api\/swarms\/sw_[0-9a-f]+\/cancel$/.test(p)) { const st = cancelSwarm(p.split('/')[3]); return st ? send(res, 200, { ok: true }) : send(res, 404, { error: 'no such swarm' }); }
    if (p === '/api/goals/event') { // from the goal runner / gemweb goal CLI
      const { name, type, ...rest } = await readBody(req);
      if (!name || !/^goal\.[\w.]+$/.test(String(type))) return send(res, 400, { error: 'name and goal.* type required' });
      events.emit(type, { task_id: `goal:${name}`, goal: name, ...rest });
      return send(res, 200, { ok: true });
    }
    if (p === '/api/web-limit') { // the driver saw a usage-limit notice: pause new dispatches
      syncConfigFromDisk(cfg);
      const b = await readBody(req);
      const t = b.task_id ? tasks.get(b.task_id) : null;
      const acctName = b.account || t?.account || defaultAccountName(cfg);
      const l = recordLimit({ notice: b.notice, task_id: b.task_id, site: SITE_NAMES.includes(b.site) ? b.site : 'gemini', account: acctName, cooldownMin: Number(cfg.gemweb.limit_cooldown_min ?? 180) });
      events.emit('web.limit', { task_id: b.task_id || undefined, ...l });
      return send(res, 200, l);
    }
    if (p === '/api/web-limit/clear') {
      const b = await readBody(req);
      const ok = clearLimit(SITE_NAMES.includes(b.site) ? b.site : null, b.account || null);
      events.emit('web.limit_cleared', { by: 'admin', site: b.site || null, account: b.account || null, had: ok });
      return send(res, 200, { ok });
    }
    if (p.startsWith('/api/confirm/')) {
      const body = await readBody(req);
      return send(res, 200, { ok: approvals.decide(p.split('/').pop(), !!body.approve, 'status-page') });
    }
    // ---- task API used by gemweb ----
    if (p === '/api/tasks') {
      syncConfigFromDisk(cfg);
      const b = await readBody(req);
      if (!b.prompt) return send(res, 400, { error: 'prompt required' });
      const site = SITE_NAMES.includes(b.site) ? b.site : 'gemini';
      let route;
      try {
        route = pickAccount(cfg, tasks.list(), slots, {
          site,
          requestedAccount: b.account || null,
          chatUrl: b.chat_url || null,
          mock: !!b.mock,
        });
      } catch (e) {
        return send(res, e.status || 400, { kind: 'account-unknown', error: e.message });
      }
      if (route.refusal) {
        events.emit('task.refused', { from: b.from, ...route.refusal });
        return send(res, 429, route.refusal);
      }
      const t = tasks.create({ prompt: b.prompt, title: b.title, from: b.from, origin: 'gemweb', chat_url: b.chat_url || null, cwd: b.cwd || null, mock: !!b.mock, site, account: route.account });
      return send(res, 200, t);
    }
    const m = /^\/api\/tasks\/([\w-]+)\/(acquire|update|release|wait|cancel)$/.exec(p);
    if (m) {
      const t = tasks.get(m[1]); if (!t) return send(res, 404, { error: 'no such task' });
      if (m[2] === 'acquire') {
        const wait = Math.min(Number(url.searchParams.get('wait') ?? 50), 55);
        return send(res, 200, await slots.acquire(t, wait * 1000));
      }
      if (m[2] === 'release') { slots.release(t.id); return send(res, 200, { ok: true }); }
      if (m[2] === 'cancel') {
        tasks.setStatus(t, 'cancelled', { error: 'cancelled by admin' });
        tasks.updateStage(t, 'idle');
        slots.release(t.id);
        const killedJobs = jobs.killByTask(t.id);
        if (t.driver?.pid && pidAlive(t.driver.pid)) {
          try { process.kill(t.driver.pid, 'SIGTERM'); } catch { /* ignore */ }
        }
        const closedTabs = await closeTaskTabsFor(cfg, t.id).catch(() => 0);
        browserCache.at = 0;
        return send(res, 200, { ok: true, task_id: t.id, killed_jobs: killedJobs, closed_tabs: closedTabs });
      }
      if (m[2] === 'update') {
        const b = await readBody(req);
        slots.beat(t.id);
        if (b.driver) { t.driver = { ...t.driver, ...b.driver }; }
        if (b.stage) tasks.updateStage(t, b.stage, b.stage_detail ?? null);
        if (b.chat_url) t.chat_url = b.chat_url;
        if (b.log) events.emit('driver.log', { task_id: t.id, level: b.level || 'info', msg: String(b.log).slice(0, 20000), ...(b.data ? { data: b.data } : {}) });
        if (b.status === 'dispatched' && !t.sent_at) t.sent_at = new Date().toISOString();
        if (b.final_from_page && !t.final) { // the model never called report: its last page reply is the answer
          const text = String(b.final_from_page);
          const rep = { at: new Date().toISOString(), status: 'final', summary: text.split('\n').find((l) => l.trim())?.slice(0, 300) || '(empty reply)', content: text, files_changed: t.files_changed, tests: '', source: 'page' };
          events.emit('report', { task_id: t.id, ...rep });
          tasks.addReport(t, rep);
        }
        if (b.status === 'timeout' && t.final) {
          // report(final) landed while the driver was already giving up (e.g. reading the page
          // fallback): the report wins, same as a final that arrives after the timeout.
          tasks.setStatus(t, t.final.status === 'final' ? 'done' : 'blocked', { error: null });
        } else if (b.status) tasks.setStatus(t, b.status, b.error ? { error: b.error } : {});
        else if (t.status === 'interrupted') tasks.setStatus(t, 'running', { revived: true }); // server restarted while the driver kept going
        else tasks.save(t);
        return send(res, 200, { ok: true });
      }
      if (m[2] === 'wait') {
        const wait = Math.min(Number(url.searchParams.get('wait') || 50), 55);
        const known = url.searchParams.get('reports');
        if (!t.final && (known === null || Number(known) === t.reports.length) && tasks.isActive(t)) await tasks.waitChange(t.id, wait * 1000);
        slots.beat(t.id);
        const { files_seen, ...rest } = tasks.get(t.id);
        return send(res, 200, rest);
      }
    }
    return send(res, 404, 'not found');
  } catch (e) {
    console.error('admin error', e);
    if (!res.headersSent) send(res, e.status || 500, { error: e.message });
  }
});

publicServer.requestTimeout = 0; publicServer.headersTimeout = 60000;
adminServer.requestTimeout = 0;
publicServer.listen(cfg.public_port, cfg.public_host, () => console.log(`public  http://${cfg.public_host}:${cfg.public_port}  (/mcp)`));
adminServer.listen(cfg.admin_port, cfg.admin_host, () => console.log(`status  http://${cfg.admin_host}:${cfg.admin_port}/`));
events.emit('server.start', { version: VERSION, pid: process.pid, public: `${cfg.public_host}:${cfg.public_port}`, admin: `${cfg.admin_host}:${cfg.admin_port}`, roots: paths.roots.map((r) => r.path) });

for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { events.emit('server.stop', { signal: sig }); process.exit(0); });
