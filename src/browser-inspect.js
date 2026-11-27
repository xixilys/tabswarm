// Live tab & browser state inspector across all configured dedicated Chrome accounts.
// Correlates each account's CDP /json/list tabs with task registries and (optionally, with --probe)
// reads non-destructive page stage (generating, waiting_confirm, rate_limited, auth_required, idle).
import {
  cdpVersion,
  cdpList,
  detectBrowserMode,
  readChromePid,
  liveContext,
  listTabs,
  readTabRegistries,
  targetIdOf,
} from './browser.js';
import { resolveAccounts, getAccount, cfgForAccount, defaultAccountName, DEFAULT_ACCOUNT } from './accounts.js';
import { siteFor } from './sites.js';

const STALE_STAGE_MS = 30_000;
const PROBE_CACHE_TTL_MS = 3_000;

const _probeCache = new Map(); // account -> { at, byTarget: Map }

function safeUrl(raw) {
  try { return new URL(raw); } catch { return null; }
}

function originOf(raw) {
  const u = safeUrl(raw);
  return u ? u.origin : null;
}

function conversationKey(raw) {
  const u = safeUrl(raw);
  if (!u) return null;
  const m = /\/(?:app|c)\/([0-9a-zA-Z_-]{6,})/.exec(u.pathname);
  return m ? `${u.origin}:${m[1]}` : null;
}

export function classifyUrl(rawUrl, cfg) {
  const u = safeUrl(rawUrl);
  if (!u) return 'other';
  const adminPort = String(cfg?.admin_port || 8782);
  if ((u.hostname === '127.0.0.1' || u.hostname === 'localhost' || u.hostname === cfg?.admin_host) && (u.port || '80') === adminPort) {
    return 'monitor';
  }
  const gemOrigin = originOf(cfg?.gemweb?.gemini_url);
  if (u.hostname === 'gemini.google.com' || (gemOrigin && u.origin === gemOrigin)) return 'gemini';
  const gptOrigin = originOf(cfg?.gemweb?.chatgpt?.url || 'https://chatgpt.com/');
  if (u.hostname === 'chatgpt.com' || u.hostname.endsWith('.chatgpt.com') || (gptOrigin && u.origin === gptOrigin)) return 'chatgpt';
  return 'other';
}

async function probePages(acct, cfg, targetIds) {
  const now = Date.now();
  const cached = _probeCache.get(acct.name);
  if (cached && now - cached.at < PROBE_CACHE_TTL_MS) {
    return cached.byTarget;
  }
  const byTarget = new Map();
  if (!targetIds.length) {
    _probeCache.set(acct.name, { at: now, byTarget });
    return byTarget;
  }
  const want = new Set(targetIds);
  let browser = null;
  try {
    const { chromium } = await import('playwright-core');
    browser = await chromium.connectOverCDP(acct.cdp_url, { timeout: 4000 });
    const ctx = browser.contexts()[0];
    if (!ctx) return byTarget;
    for (const page of ctx.pages()) {
      if (page.isClosed()) continue;
      const tid = await targetIdOf(ctx, page).catch(() => null);
      if (!tid || !want.has(tid)) continue;
      const siteName = classifyUrl(page.url(), cfg);
      if (siteName !== 'gemini' && siteName !== 'chatgpt') continue;
      const site = siteFor(siteName);
      const info = { stage: 'idle', detail: null, model: null };
      try {
        if (await site.signedOut(page)) {
          info.stage = 'auth_required';
        } else {
          const lim = await site.limit(page).catch(() => null);
          if (lim) {
            info.stage = 'rate_limited';
            info.detail = lim;
          } else if (site.pendingConfirm && await site.pendingConfirm(page).catch(() => false)) {
            info.stage = 'waiting_confirm';
          } else if (await site.generating(page).catch(() => false)) {
            info.stage = 'generating';
          }
          if (site.readSelectedModel) {
            info.model = await site.readSelectedModel(page).catch(() => null);
          }
        }
      } catch {
        info.stage = 'unknown';
      }
      byTarget.set(tid, info);
    }
    _probeCache.set(acct.name, { at: Date.now(), byTarget });
  } catch {
    // Non-fatal: return best-effort results collected so far.
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
  return byTarget;
}

async function inspectOneAccount(acct0, cfg, taskStore, { probe = false } = {}) {
  // embedded (desktop app) when that is the configured and running browser, else the dedicated Chrome
  const { acct } = await liveContext(cfg, acct0.name, { launch: false }).catch(() => ({ acct: acct0 }));
  const v = await cdpVersion(acct.cdp_url);
  const pid = readChromePid(acct.name);
  if (!v) {
    return {
      account: acct.name,
      label: acct.label,
      running: false,
      mode: 'down',
      cdp_url: acct.cdp_url,
      port: acct.port,
      profile_dir: acct.profile_dir,
      browser_version: null,
      pid,
      tab_count: 0,
      site_counts: { gemini: 0, chatgpt: 0, monitor: 0, other: 0 },
      tabs: [],
    };
  }

  const scfg = cfgForAccount(cfg, acct.name);
  const [mode, rawTabs] = await Promise.all([detectBrowserMode(scfg, acct.name), acct.embedded ? listTabs(cfg, acct.name) : cdpList(acct.cdp_url)]);
  const registries = readTabRegistries(acct.name);
  const allTasks = taskStore.list();
  const activeByChatKey = new Map();
  for (const t of allTasks) {
    if ((t.account || DEFAULT_ACCOUNT) !== acct.name) continue;
    if (!taskStore.isActive(t) || !t.chat_url) continue;
    const k = conversationKey(t.chat_url);
    if (k && !activeByChatKey.has(k)) activeByChatKey.set(k, t);
  }

  const aiTargetIds = [];
  const prelim = rawTabs.map((tab) => {
    const site = classifyUrl(tab.url, cfg);
    if (site === 'gemini' || site === 'chatgpt') aiTargetIds.push(tab.id);
    const reg = registries.get(tab.id);
    let task = reg?.task_id ? taskStore.get(reg.task_id) : null;
    if (!task && (site === 'gemini' || site === 'chatgpt')) {
      const k = conversationKey(tab.url);
      if (k) task = activeByChatKey.get(k) || null;
    }
    return { tab, site, reg, task };
  });

  const probed = probe ? await probePages(acct, cfg, aiTargetIds) : new Map();
  const site_counts = { gemini: 0, chatgpt: 0, monitor: 0, other: 0 };
  const now = Date.now();

  const tabs = prelim.map(({ tab, site, reg, task }) => {
    site_counts[site] = (site_counts[site] || 0) + 1;
    const modeKind = site === 'monitor'
      ? 'monitor'
      : (task && task.origin === 'gemweb' ? 'task' : (site === 'gemini' || site === 'chatgpt' ? 'manual' : 'other'));

    const p = probed.get(tab.id);
    let stage = site === 'monitor' ? 'dashboard' : 'idle';
    let stage_detail = null;
    let model = task?.driver?.model || null;

    if (p) {
      stage = p.stage;
      stage_detail = p.detail || null;
      if (p.model) model = p.model;
    } else if (task?.driver?.stage) {
      const updatedMs = Date.parse(task.driver.stage_updated_at || task.updated || 0);
      stage = (updatedMs && now - updatedMs > STALE_STAGE_MS && taskStore.isActive(task))
        ? 'stale'
        : task.driver.stage;
      stage_detail = task.driver.stage_detail || null;
    }

    return {
      target_id: tab.id,
      account: acct.name,
      account_label: acct.label,
      cdp_url: acct.cdp_url,
      site,
      mode: modeKind,
      stage,
      stage_detail,
      model,
      title: String(tab.title || '').slice(0, 140),
      url: String(tab.url || ''),
      task_id: task?.id || reg?.task_id || null,
      task_status: task?.status || null,
      task_title: task?.title || null,
      tool_calls: task?.tool_calls ?? null,
    };
  });

  return {
    account: acct.name,
    label: acct.label,
    running: true,
    mode,
    cdp_url: acct.cdp_url,
    port: acct.port,
    profile_dir: acct.profile_dir,
    browser_version: v.Browser || null,
    pid,
    tab_count: tabs.length,
    site_counts,
    tabs,
  };
}

export async function inspectAllAccounts(cfg, taskStore, { probe = false, account = null } = {}) {
  const accounts = account ? [getAccount(cfg, account)] : resolveAccounts(cfg);
  const perAccount = await Promise.all(accounts.map((a) => inspectOneAccount(a, cfg, taskStore, { probe })));
  const defName = account || defaultAccountName(cfg);
  const primary = perAccount.find((a) => a.account === defName) || perAccount[0];
  const site_counts = { gemini: 0, chatgpt: 0, monitor: 0, other: 0 };
  const tabs = [];
  for (const a of perAccount) {
    for (const [k, n] of Object.entries(a.site_counts || {})) {
      site_counts[k] = (site_counts[k] || 0) + n;
    }
    tabs.push(...a.tabs);
  }
  return {
    running: perAccount.some((a) => a.running),
    mode: primary?.mode || 'down',
    cdp_url: primary?.cdp_url || cfg?.gemweb?.cdp_url || 'http://127.0.0.1:9230',
    profile_dir: primary?.profile_dir || null,
    browser_version: primary?.browser_version || null,
    pid: primary?.pid || null,
    tab_count: tabs.length,
    site_counts,
    tabs,
    accounts: perAccount,
  };
}

export const inspectTabs = inspectAllAccounts;
