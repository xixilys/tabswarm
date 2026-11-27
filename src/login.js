// `webhub login <site>` / `webhub browser ...`: manage dedicated Chrome windows per account,
// sign in to Gemini / ChatGPT once, and inspect auth state without touching everyday Chrome.
import readline from 'node:readline';
import {
  cdpVersion,
  cdpList,
  ensureDedicated,
  stopDedicated,
  detectBrowserMode,
  openLoginWindow,
  restartHeadless,
  bringChromeFront,
  monitorUrl,
  openTab,
  focusTab,
  Dedicated,
  LOGIN_URLS,
  liveContext,
  listTabs,
  browserModeSetting,
  readEmbeddedInfo,
  embeddedApi,
} from './browser.js';
import fs from 'node:fs';
import { CONFIG_PATH } from './config.js';
import { resolveAccounts, getAccount, cfgForAccount, defaultAccountName, syncConfigFromDisk, updateUserConfig } from './accounts.js';
import { siteFor } from './sites.js';
import { chromePathFor } from './browser.js';
import { externalLogin, postCookiesSettled, chromeOwnsPort, signedInCookies, loginExternalHint, acquireLoginLock } from './login-external.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Opens the site in a fresh tab of the account's dedicated Chrome and reports whether it is signed in.
export async function signedIn(cfg, siteName, account = null) {
  const site = siteFor(siteName);
  const acct = getAccount(cfg, account);
  const scfg = cfgForAccount(cfg, acct.name);
  const probeId = `probe-${acct.name}-${siteName}-${process.pid}`;
  const d = await Dedicated.connect(scfg, probeId, () => {}, { account: acct.name });
  try {
    const page = await d.newPage();
    await page.goto(site.newChatUrl(scfg), { waitUntil: 'domcontentloaded', timeout: 45000 });
    if (site.waitCloudflare) await site.waitCloudflare(page).catch(() => {});
    await sleep(4000);
    return !(await site.signedOut(page));
  } finally {
    await d.closeTaskTabs().catch(() => {});
    await d.disconnect();
  }
}

async function runningTasks(api, accountName = null) {
  try {
    const s = await api('/state');
    if (accountName && s.slots?.by_account?.[accountName]) {
      const ba = s.slots.by_account[accountName];
      return [...(ba.gemini?.running || []), ...(ba.chatgpt?.running || [])];
    }
    return s.slots?.running || [];
  } catch { return []; }
}

function waitEnter(msg) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(msg, () => { rl.close(); resolve(); });
  });
}

function parseLoginArgs(rawArgs, explicitAccount = null) {
  let account = explicitAccount;
  let force = false;
  let check = false;
  let all = false;
  let timeout = null;
  let badAccount = false;
  let url = null;
  const pos = [];
  for (let i = 0; i < rawArgs.length; i++) {
    const a = rawArgs[i];
    if (a === '--account' || a === '-a') { account = rawArgs[++i]; if (!account || account.startsWith('-')) { badAccount = true; account = null; } }
    else if (a.startsWith('--account=')) { account = a.slice(10); if (!account) { badAccount = true; account = null; } }
    else if (a === '--force') force = true;
    else if (a === '--check') check = true;
    else if (a === '--all') all = true;
    else if (a === '--timeout') timeout = rawArgs[++i];
    else if (a.startsWith('--timeout=')) timeout = a.slice(10);
    else if (a === '--url') url = rawArgs[++i];
    else if (a.startsWith('--url=')) url = a.slice(6);
    else if (a === '--site') pos.push(rawArgs[++i]);
    else pos.push(a);
  }
  return { pos, account, force, check, all, timeout, url, badAccount };
}

export async function loginCli(args, { cfg, api, account: initAccount = null }) {
  const { pos, account: parsedAccount, force, check, all, timeout, url: startUrl, badAccount } = parseLoginArgs(args, initAccount);
  if (badAccount) { console.error('login: --account needs an account name'); return 2; }
  const sub = pos[0] || 'status';
  const hasExplicitAccount = !!parsedAccount;
  const acctName = parsedAccount || defaultAccountName(cfg);

  if (sub === 'up') {
    const targets = all ? resolveAccounts(cfg).filter((a) => a.enabled) : [getAccount(cfg, acctName)];
    for (const acct of targets) {
      const scfg = cfgForAccount(cfg, acct.name);
      await ensureDedicated(scfg, (m) => console.log(m), { ensureMonitorTab: acct.headless !== true, account: acct.name });
      const live = await liveContext(scfg, acct.name, { launch: false });
      const tabs = await listTabs(scfg, acct.name);
      if (live.embedded) console.log(`embedded browser [${acct.name}] up (Web AI Hub app), ${tabs.length} tab(s), CDP ${live.acct.cdp_url}, partition persist:webhub-${acct.name}`);
      else console.log(`dedicated Chrome [${acct.name}] up (${await detectBrowserMode(scfg, acct.name)}), ${tabs.length} tab(s), CDP ${acct.cdp_url}, profile ${acct.profile_dir}`);
    }
    return 0;
  }

  if (sub === 'down') {
    const targets = all ? resolveAccounts(cfg) : [getAccount(cfg, acctName)];
    for (const acct of targets) {
      const busy = await runningTasks(api, acct.name);
      if (busy.length && !force) {
        console.error(`browser down [${acct.name}]: ${busy.length} task(s) running (${busy.join(', ')}); pass --force to stop anyway.`);
        return 2;
      }
      const res = await stopDedicated(cfgForAccount(cfg, acct.name), acct.name);
      if (res.embedded) console.log(`embedded browser [${acct.name}]: closed ${res.closed_tabs} tab(s); the Web AI Hub app keeps running`);
      else console.log(res.stopped ? `stopped dedicated Chrome [${acct.name}] (pid ${res.pid})` : `dedicated Chrome [${acct.name}] was not running`);
    }
    return 0;
  }

  if (sub === 'show') {
    const acct = getAccount(cfg, acctName);
    const scfg = cfgForAccount(cfg, acct.name);
    const live = await liveContext(scfg, acct.name, { log: (m) => console.log(m) });
    if (live.embedded) { await embeddedApi(live.embedded, 'POST', '/show', {}); console.log('Web AI Hub app shown (embedded browser)'); return 0; }
    await ensureDedicated(scfg, (m) => console.log(m), { headless: false, ensureMonitorTab: true, account: acct.name });
    const mon = monitorUrl(scfg, acct.name);
    const baseMon = `http://${scfg?.admin_host || '127.0.0.1'}:${scfg?.admin_port || 8782}/`;
    const tabs = await cdpList(acct.cdp_url);
    const t = tabs.find((x) => (x.url || '').startsWith(baseMon));
    if (t) await focusTab(scfg, t.id, { bringToFront: true, account: acct.name });
    else await openTab(scfg, mon, { activate: true, bringToFront: true, account: acct.name });
    return 0;
  }

  if (sub === 'login') {
    const site = (pos[1] && !pos[1].startsWith('--')) ? pos[1] : 'gemini';
    if (!LOGIN_URLS[site]) {
      console.error(`login: unknown site "${site}" (${Object.keys(LOGIN_URLS).join('|')})`);
      return 2;
    }
    const acct = getAccount(cfg, acctName);
    const scfg = cfgForAccount(cfg, acct.name);
    const mode = await detectBrowserMode(scfg, acct.name);
    const busy = await runningTasks(api, acct.name);
    if (busy.length && mode === 'headless' && !force) {
      console.error(`login [${acct.name}]: ${busy.length} task(s) running in headless Chrome (${busy.join(', ')}); switching to a visible window restarts it. Wait or add --force.`);
      return 2;
    }
    // Google refuses sign-in inside the embedded browser: Gemini signs in through a Chrome window
    if (site === 'gemini' && browserModeSetting(scfg, acct.name) === 'embedded' && readEmbeddedInfo()) {
      return loginCli(['login-external', 'gemini', '--account', acct.name, ...(timeout ? ['--timeout', timeout] : [])], { cfg, api });
    }
    const opened = await openLoginWindow(scfg, site, { account: acct.name });
    if (opened.embedded) {
      console.log(`Opened ${site} in the Web AI Hub app (embedded browser [${acct.name}], tab ${opened.target_id || '?'}). Sign in there once; the login is kept in partition persist:webhub-${acct.name}.`);
      if (site === 'chatgpt') console.log('Already signed in to ChatGPT in the dedicated Chrome? `webhub browser import-login chatgpt` copies that session instead.');
      return 0;
    }
    console.log(`Opened ${site} in dedicated Chrome [${acct.name}] (tab ${opened.target_id || '?'}, CDP ${acct.cdp_url}, profile ${acct.profile_dir}).`);
    console.log(`Sign in to ${site === 'gemini' ? 'Google (Gemini)' : 'ChatGPT'} in that dedicated Chrome window (never touches your everyday Chrome).`);
    if (!process.stdin.isTTY) {
      console.log(`When done, verify with: webhub browser status --check --account ${acct.name}`);
      return 0;
    }
    await waitEnter('Press Enter here when you are signed in… ');
    return finishLogin(scfg, api, site, force, acct);
  }

  if (sub === 'headless') {
    const acct = getAccount(cfg, acctName);
    return finishLogin(cfgForAccount(cfg, acct.name), api, null, force, acct);
  }

  if (sub === 'status') {
    const targets = hasExplicitAccount ? [getAccount(cfg, acctName)] : resolveAccounts(cfg);
    for (const acct of targets) {
      const scfg = cfgForAccount(cfg, acct.name);
      if (check) await ensureDedicated(scfg, () => {}, { ensureMonitorTab: acct.headless !== true, account: acct.name });
      const live = await liveContext(scfg, acct.name, { launch: false });
      const setting = browserModeSetting(scfg, acct.name);
      if (live.embedded) {
        const tabs = await listTabs(scfg, acct.name);
        const cl = (await embeddedApi(live.embedded, 'GET', `/cookies/${acct.name}`).catch(() => ({ cookies: [] }))).cookies;
        const gpt = signedInCookies('chatgpt', cl) ? 'session cookie present' : 'not signed in';
        const gem = signedInCookies('gemini', cl) ? 'google session present' : `not signed in (${loginExternalHint('gemini', acct.name)})`;
        console.log(`embedded browser [${acct.name}${acct.is_default ? ' (default)' : ''}]  Web AI Hub app on ${live.acct.cdp_url} (embedded, ${tabs.length} tab(s))  partition persist:webhub-${acct.name}  chatgpt: ${gpt}  gemini: ${gem}`);
      } else if (setting === 'embedded') {
        console.log(`embedded browser [${acct.name}]  Web AI Hub app not running — tasks start it, or fall back to the dedicated Chrome below`);
      }
      if (live.embedded && !check) continue;
      const v = await cdpVersion(acct.cdp_url);
      const mode = await detectBrowserMode(scfg, acct.name);
      const tabs = v ? await cdpList(acct.cdp_url) : [];
      const tag = `[${acct.name}${acct.is_default ? ' (default)' : ''}${acct.enabled ? '' : ', disabled'}]`;
      console.log(`dedicated Chrome ${tag}  ${v ? `${v.Browser} on ${acct.cdp_url} (${mode}, ${tabs.length} tab(s))` : `not running (starts on demand, ${acct.cdp_url})`}  sites=${acct.sites.join(',')}  profile ${acct.profile_dir}`);
      if (v && check) {
        for (const s of acct.sites) {
          const res = await signedIn(scfg, s, acct.name).catch((e) => `error: ${e.message}`);
          const hint = `webhub login ${s}${acct.name !== 'default' ? ' --account ' + acct.name : ''}`;
          console.log(`  ${s.padEnd(8)}  ${res === true ? 'signed in' : typeof res === 'string' ? res : 'NOT signed in — run: ' + hint}`);
        }
      }
    }
    return 0;
  }

  if (sub === 'mode') {
    // webhub browser mode [embedded|chrome] [--account NAME]
    const want = pos[1];
    if (!want) { console.log(`browser mode: ${browserModeSetting(cfg, hasExplicitAccount ? acctName : null)} (gemweb.browser_mode${hasExplicitAccount ? `, account ${acctName}` : ''})`); return 0; }
    if (!['embedded', 'chrome'].includes(want)) { console.error('usage: webhub browser mode [embedded|chrome] [--account NAME]'); return 2; }
    updateUserConfig((user) => {
      user.gemweb ||= {};
      if (hasExplicitAccount) { user.gemweb.accounts ||= {}; user.gemweb.accounts[acctName] = { ...(user.gemweb.accounts[acctName] || {}), browser_mode: want }; }
      else user.gemweb.browser_mode = want;
    });
    console.log(`browser mode set to ${want}${hasExplicitAccount ? ` for account ${acctName}` : ''} — new tasks use the ${want === 'embedded' ? 'embedded browser in the Web AI Hub app' : 'dedicated external Chrome'}`);
    console.log('restart the Web AI Hub app once so it opens (or closes) its embedded-browser ports accordingly');
    return 0;
  }

  if (sub === 'login-external') {
    // webhub browser login-external gemini|chatgpt [--account NAME] [--timeout SEC] [--url URL]
    // Sign in in a normal Chrome window (Google blocks sign-in inside embedded browsers), then copy
    // the site's session cookies into the account's embedded partition. Used by the app's tabs.
    const site = pos[1] || 'gemini';
    if (!['gemini', 'chatgpt'].includes(site)) { console.error('usage: webhub browser login-external gemini|chatgpt [--account NAME]'); return 2; }
    let acct;
    try { acct = getAccount(cfg, acctName); } catch (e) { console.error(`login-external: ${e.message}`); return 2; }
    try {
      const r = await externalLogin(cfg, site, { account: acct.name, timeoutSec: Number(timeout) || 900, url: startUrl, log: (m) => console.log(m) });
      console.log(`signed in: copied ${r.imported ?? "the"} ${site} cookie(s) into the embedded browser [${acct.name}]${r.failed ? ` (${r.failed} skipped)` : ''}; sign-in profile kept at ${r.profile}`);
      return 0;
    } catch (e) {
      console.error(`login-external: ${e.message}`);
      return [2, 3, 4, 5].includes(e.code) ? e.code : 1;
    }
  }

  if (sub === 'import-login') {
    // Copies the ChatGPT session of the dedicated Chrome into the embedded browser. Read-only on
    // Chrome (cookies are read over CDP; the profile and its login are left as they are).
    // Google (Gemini) is not imported: copied Google sessions trip its cookie-theft protection.
    const site = pos[1] || 'chatgpt';
    const acct0 = getAccount(cfg, acctName);
    if (site !== 'chatgpt') { console.error('import-login: only chatgpt can be imported from the dedicated Chrome (copying its Google session could sign it out); for Gemini run `' + loginExternalHint('gemini', acct0.name) + '`'); return 2; }
    const emb = readEmbeddedInfo();
    if (!emb) { console.error('import-login: the Web AI Hub app (embedded browser) is not running — open it first'); return 2; }
    // the whole transaction (resolve the account, read its Chrome, write the app) runs under the lock that
    // sign-ins and purges use, from a configuration read after the lock is held
    const release = await acquireLoginLock(cfg, { account: acct0.name, site: 'chatgpt' }).catch((e) => { console.error(`import-login: ${e.message}`); return null; });
    if (!release) return 2;
    try {
      syncConfigFromDisk(cfg);
      let acct;
      try { acct = getAccount(cfg, acct0.name); } catch (e) { console.error(`import-login: ${e.message}`); return 2; }
      // the Chrome on that port must really be this account's (started with its profile), not whatever listens there
      const loopback = (() => { try { return ['127.0.0.1', 'localhost', '[::1]'].includes(new URL(acct.cdp_url).hostname); } catch { return false; } })();
      if (!loopback) { console.error(`import-login: ${acct.cdp_url} is not a local (loopback) address; its owner cannot be verified, nothing read`); return 2; }
      const notOurs = () => !chromeOwnsPort(acct.port, acct.profile_dir, chromePathFor(cfg));
      if (!(await cdpVersion(acct.cdp_url))) { console.error(`import-login: dedicated Chrome [${acct.name}] is not running on ${acct.cdp_url}; nothing to import from (it is not started for this)`); return 2; }
      if (notOurs()) { console.error(`import-login: what listens on ${acct.cdp_url} is not the dedicated Chrome of [${acct.name}] (profile ${acct.profile_dir}); nothing read`); return 2; }
      const { chromium } = await import('playwright-core');
      const browser = await chromium.connectOverCDP(acct.cdp_url, { timeout: 15000 });
      let cookies = [];
      try {
        const bs = await browser.newBrowserCDPSession();
        try { cookies = (await bs.send('Storage.getCookies')).cookies || []; } finally { await bs.detach().catch(() => {}); }
      } finally { await browser.close().catch(() => {}); } // disconnects only; Chrome keeps running
      const mine = cookies.filter((c) => /(^|\.)(chatgpt\.com|openai\.com)$/.test(String(c.domain).replace(/^\./, '')));
      if (!mine.some((c) => c.name.startsWith('__Secure-next-auth.session-token'))) { console.error(`import-login: ChatGPT is not signed in in dedicated Chrome [${acct.name}]`); return 3; }
      // the account must still be bound to the Chrome we read from when we write
      syncConfigFromDisk(cfg);
      let again;
      try { again = getAccount(cfg, acct.name); } catch (e) { console.error(`import-login: ${e.message}`); return 2; }
      if (notOurs()) { console.error(`import-login: the Chrome on ${acct.cdp_url} is no longer [${acct.name}]'s; nothing written`); return 2; }
      if (again.cdp_url !== acct.cdp_url || again.profile_dir !== acct.profile_dir || again.port !== acct.port) { console.error(`import-login: account ${acct.name} was re-bound while importing; nothing written`); return 2; }
      const posted = await postCookiesSettled(emb, acct.name, mine);
      if (!posted.r) { // timed out, then the app finished: judge by what is in the partition
        const have = (await embeddedApi(emb, 'GET', `/cookies/${acct.name}`).catch(() => ({ cookies: [] }))).cookies;
        if (!signedInCookies('chatgpt', have)) { console.error('import-login: the app finished importing after the timeout but the ChatGPT session is not in the partition'); return 4; }
        console.log(`imported ChatGPT cookies into the embedded browser [${acct.name}] (the app answered late); the dedicated Chrome login is untouched`);
        return 0;
      }
      const r = posted.r;
      console.log(`imported ${r.imported} ChatGPT cookie(s) into the embedded browser [${acct.name}]${r.failed ? ` (${r.failed} skipped)` : ''}; the dedicated Chrome login is untouched`);
      return 0;
    } finally { release(); }
  }

  console.error('usage: webhub login [gemini|chatgpt] [--account NAME] | webhub browser [up|down|show|status [--check]|headless|mode [embedded|chrome]|import-login [chatgpt]|login-external gemini|chatgpt] [--account NAME|--all] [--force]');
  return 2;
}

async function finishLogin(scfg, api, site, force, acct) {
  if (site) {
    const ok = await signedIn(scfg, site, acct.name).catch(() => false);
    console.log(ok ? `[${acct.name}] ${site}: signed in.` : `[${acct.name}] ${site}: still NOT signed in — sign in inside the dedicated Chrome window and re-run check.`);
    if (!ok) return 3;
  }
  if (acct.headless !== true) {
    console.log(`dedicated Chrome [${acct.name}] stays open in visible mode (headless = false).`);
    return 0;
  }
  const mode = await detectBrowserMode(scfg, acct.name);
  if (mode !== 'headless') {
    const busy = await runningTasks(api, acct.name);
    if (busy.length && !force) {
      console.log(`leaving window open [${acct.name}]: ${busy.length} task(s) running (${busy.join(', ')}). Run webhub browser headless --account ${acct.name} later.`);
      return 0;
    }
    console.log(`waiting 30 s so Chrome [${acct.name}] writes cookies to disk, then switching back to headless…`);
    await sleep(30000);
    await restartHeadless(scfg, { account: acct.name });
    console.log(`dedicated Chrome [${acct.name}] is headless again (${await detectBrowserMode(scfg, acct.name)}).`);
    if (site) console.log(`[${acct.name}] ${site} after restart: ${(await signedIn(scfg, site, acct.name).catch(() => false)) ? 'signed in' : 'NOT signed in'}`);
  } else {
    console.log(`dedicated Chrome [${acct.name}] is already headless.`);
  }
  return 0;
}
