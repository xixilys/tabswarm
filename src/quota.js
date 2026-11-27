// Dispatch guard and account router for web-model subscriptions, per (site, account):
// at most `account.daily_limit` tasks sent per local day, and after a usage-limit notice on
// the page no new dispatch to that (site, account) for `limit_cooldown_min` (or `webhub limit clear`).
// Mock-driver tasks (tests) never count.
import fs from 'node:fs';
import path from 'node:path';
import { STATE_DIR } from './config.js';
import { resolveAccounts, getAccount, defaultAccountName, DEFAULT_ACCOUNT } from './accounts.js';

export const SITE_NAMES = ['gemini', 'chatgpt'];
const siteOf = (t) => t.site || 'gemini';
const accountOf = (t) => t.account || DEFAULT_ACCOUNT;

const LIMIT_FILE = (site = 'gemini', account = DEFAULT_ACCOUNT) => {
  const acct = account || DEFAULT_ACCOUNT;
  if (acct === DEFAULT_ACCOUNT) {
    return path.join(STATE_DIR, 'run', site === 'gemini' ? 'web-limit.json' : `web-limit-${site}.json`);
  }
  return path.join(STATE_DIR, 'run', `web-limit-${site}-${acct}.json`);
};

export function localDay(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// Tasks that used (or are about to use) the web model today: sent today, or still starting.
// Pass `account = null` to aggregate across all accounts, or an account name to scope to it.
export function usedToday(tasks, now = new Date(), site = 'gemini', account = null) {
  const day = localDay(now);
  return tasks.filter((t) => t.origin === 'gemweb' && !t.mock && siteOf(t) === site
    && (!account || accountOf(t) === account)
    && (
      (t.sent_at && localDay(new Date(t.sent_at)) === day)
      || (!t.sent_at && ['queued', 'starting'].includes(t.status) && localDay(new Date(t.created)) === day)
    )).length;
}

export function readLimit(site = 'gemini', account = DEFAULT_ACCOUNT) {
  try { return JSON.parse(fs.readFileSync(LIMIT_FILE(site, account), 'utf8')); } catch { return null; }
}

export function activeLimit(now = Date.now(), site = 'gemini', account = DEFAULT_ACCOUNT) {
  const l = readLimit(site, account);
  return l && Date.parse(l.until) > now ? l : null;
}

export function recordLimit({ notice, task_id, cooldownMin, site = 'gemini', account = DEFAULT_ACCOUNT }) {
  const at = new Date();
  const acct = account || DEFAULT_ACCOUNT;
  const l = {
    site,
    account: acct,
    at: at.toISOString(),
    until: new Date(at.getTime() + cooldownMin * 60000).toISOString(),
    notice: String(notice || '').slice(0, 300),
    task_id: task_id || null,
  };
  const f = LIMIT_FILE(site, acct);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify(l, null, 2));
  return l;
}

// site null = every site; account null = every account.
export function clearLimit(site = null, account = null) {
  let any = false;
  if (account) {
    for (const s of site ? [site] : SITE_NAMES) {
      try { fs.unlinkSync(LIMIT_FILE(s, account)); any = true; } catch { /* none */ }
    }
    return any;
  }
  const runDir = path.join(STATE_DIR, 'run');
  let files = [];
  try { files = fs.readdirSync(runDir); } catch { return false; }
  for (const f of files) {
    if (!/^web-limit.*\.json$/.test(f)) continue;
    const matchSite = !site
      || (site === 'gemini' && (f === 'web-limit.json' || f.startsWith('web-limit-gemini-')))
      || (site !== 'gemini' && (f === `web-limit-${site}.json` || f.startsWith(`web-limit-${site}-`)));
    if (!matchSite) continue;
    try { fs.unlinkSync(path.join(runDir, f)); any = true; } catch { /* none */ }
  }
  return any;
}

// null if a new web dispatch may start for (site, account), else { kind, error, ... }.
export function dispatchRefusal(cfg, tasks, { mock = false, now = new Date(), site = 'gemini', account = DEFAULT_ACCOUNT } = {}) {
  if (mock) return null;
  let acct;
  try { acct = getAccount(cfg, account); } catch (e) { return { kind: 'account-unknown', site, account, error: e.message }; }
  const acctTag = acct.name === DEFAULT_ACCOUNT ? '' : ` [${acct.name}]`;
  if (!acct.enabled) {
    return { kind: 'account-disabled', site, account: acct.name, error: `Account "${acct.name}" is disabled` };
  }
  if (!acct.sites.includes(site)) {
    return { kind: 'site-disabled', site, account: acct.name, error: `Account "${acct.name}" is not enabled for ${site}` };
  }
  const label = site === 'chatgpt' ? 'ChatGPT' : 'Gemini';
  const lim = activeLimit(now.getTime(), site, acct.name);
  if (lim) {
    const clearHint = acct.name === DEFAULT_ACCOUNT ? 'gemweb limit clear' : `webhub limit clear ${site} --account ${acct.name}`;
    return {
      kind: 'rate-limit',
      site,
      account: acct.name,
      error: `${label}${acctTag} showed a usage-limit notice at ${lim.at} ("${lim.notice}"); new ${label} tasks are paused until ${lim.until} (${clearHint} to resume earlier)`,
      until: lim.until,
    };
  }
  const cap = Number(acct.daily_limit ?? cfg.gemweb.daily_limit ?? 30);
  const used = usedToday(tasks, now, site, acct.name);
  if (cap > 0 && used >= cap) {
    return {
      kind: 'daily-cap',
      site,
      account: acct.name,
      error: `${used} tasks already sent to ${label}${acctTag} today (daily_limit = ${cap}); resumes after local midnight`,
    };
  }
  return null;
}

function conversationKey(rawUrl) {
  try {
    const u = new URL(rawUrl);
    const m = /\/(?:app|c)\/([0-9a-zA-Z_-]{6,})/.exec(u.pathname);
    return m ? `${u.origin}:${m[1]}` : null;
  } catch { return null; }
}

// Selects the account to run a new dispatch on:
// - `--chat <url>` without explicit non-auto `--account`: pins to the account that owns that conversation
// - explicit `--account <name>` (not `auto`): strictly uses that account (refuses if limited/disabled)
// - `--account auto`: balances across all healthy accounts for `site` by load & daily count
// - omitted `--account`: prefers default account unless unavailable or busy with auto_failover enabled
export function pickAccount(cfg, tasks, slots, { site = 'gemini', requestedAccount = null, chatUrl = null, mock = false, now = new Date() } = {}) {
  const req = requestedAccount ? String(requestedAccount).trim().toLowerCase() : null;

  if (chatUrl && (!req || req === 'auto')) {
    const key = conversationKey(chatUrl);
    const hit = tasks.find((t) => t.chat_url && (t.chat_url === chatUrl || (key && conversationKey(t.chat_url) === key)));
    if (hit) {
      const pinned = getAccount(cfg, hit.account || DEFAULT_ACCOUNT);
      const refusal = dispatchRefusal(cfg, tasks, { mock, now, site, account: pinned.name });
      return { account: pinned.name, refusal, reason: 'chat-affinity' };
    }
  }

  if (req && req !== 'auto') {
    const acct = getAccount(cfg, req);
    const refusal = dispatchRefusal(cfg, tasks, { mock, now, site, account: acct.name });
    return { account: acct.name, refusal, reason: 'explicit' };
  }

  const candidates = resolveAccounts(cfg).filter((a) => a.enabled && a.sites.includes(site));
  if (!candidates.length) {
    return {
      account: defaultAccountName(cfg),
      refusal: { kind: 'account-disabled', site, error: `no enabled account supports ${site}` },
      reason: 'none',
    };
  }

  const scored = candidates.map((acct) => {
    const refusal = dispatchRefusal(cfg, tasks, { mock, now, site, account: acct.name });
    const running = slots?.runningCount ? slots.runningCount(site, acct.name) : 0;
    const limit = Math.max(1, acct.concurrency || 1);
    const used = usedToday(tasks, now, site, acct.name);
    return { acct, refusal, healthy: refusal === null, running, limit, busy: running >= limit, load: running / limit, used };
  });

  const healthy = scored.filter((x) => x.healthy);
  const defName = defaultAccountName(cfg);
  if (!healthy.length) {
    const def = scored.find((x) => x.acct.name === defName) || scored[0];
    const refusal = { ...def.refusal };
    if (scored.length > 1) {
      refusal.error += ` (checked ${scored.length} enabled ${site} accounts; all blocked)`;
    }
    return { account: def.acct.name, refusal, reason: 'all-blocked' };
  }

  if (req === 'auto') {
    healthy.sort((a, b) => (a.load - b.load) || (a.used - b.used) || ((a.acct.name === defName ? 0 : 1) - (b.acct.name === defName ? 0 : 1)));
    return { account: healthy[0].acct.name, refusal: null, reason: 'auto' };
  }

  const defHealthy = healthy.find((x) => x.acct.name === defName);
  const failover = cfg?.gemweb?.auto_failover !== false;
  if (defHealthy && (!defHealthy.busy || !failover)) {
    return { account: defHealthy.acct.name, refusal: null, reason: 'default' };
  }

  healthy.sort((a, b) => ((a.busy ? 1 : 0) - (b.busy ? 1 : 0)) || (a.load - b.load) || (a.used - b.used) || ((a.acct.name === defName ? 0 : 1) - (b.acct.name === defName ? 0 : 1)));
  return { account: healthy[0].acct.name, refusal: null, reason: defHealthy ? 'spillover' : 'failover' };
}
