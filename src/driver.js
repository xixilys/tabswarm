// gemweb driver: puts a task into its own web-model conversation (Gemini or ChatGPT) and waits
// for the result to come back through the MCP `report` tool.
//
//   1. create the task on the MCP server (gets task_id), take a browser slot (per-site limit)
//   2. fast path, in the dedicated browser (the desktop app's embedded pages, or a dedicated Chrome
//      with its own profile and CDP port; gemweb.browser = "cdp", default): own tab per task,
//      connector selected ("@<name>"), model / thinking level picked and read back, task card sent. Site steps live in src/sites.js. The owner's everyday Chrome (Browser MCP
//      extension, gemweb.browser = "browsermcp") is opt-in only, and Gemini only.
//   3. optional: if the fast path fails (UI changed, connector menu not found, ...) and
//      gemweb.operator_models is set, a cheap operator model does the same steps through
//      Playwright MCP on the same browser (gemweb.operator_bin, a DSH-compatible CLI)
//   4. wait for report(task_id, final); meanwhile confirm the site's own tool prompts (the
//      server's policy still applies), watch for usage-limit notices, keep the slot alive
//   5. every tab the task opened is closed when it ends; page text is only a timeout fallback
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { STATE_DIR, expandHome } from './config.js';
import { cfgForAccount, defaultAccountName } from './accounts.js';
import { BmSession, BrowserMcpError } from './bmcp.js';
import { Blocked, NeedOperator } from './errors.js';
import { Dedicated, BrowserBlocked, closeTaskTabsFor } from './browser.js';
import { gemini, siteFor, englishUrl } from './sites.js';
import { loginExternalHint } from './login-external.js';

export { Blocked, englishUrl };
// Gemini selectors (also used by the Browser MCP path).
export const SEL = gemini.SEL;

export function composePrompt(taskId, task, cfg, site = gemini, cwd = null) {
  const conn = site.connector(cfg);
  // ChatGPT: the task as given plus one sentence about task_id/report; no rules block, no role text.
  if (site.name === 'chatgpt') return `${cwd ? `Working directory: ${cwd}\n\n` : ''}${task}\n\nPass task_id="${taskId}" on every ${conn} tool call, and when you are done call report(task_id="${taskId}", status="final", summary, content=<your answer>).`;
  return `TASK_ID: ${taskId}
Use the "${conn}" ${site.name === 'chatgpt' ? 'connector' : 'app'} (MCP tools: list_roots, list_dir, read_file, write_file, edit_file, search, run_command, command_output, git_status, git_diff, git_log, report) to do the task below on this computer.
Rules:
- Pass task_id="${taskId}" on EVERY tool call.
- Do the task with the tools (read before editing, run the tests you mention). Do not ask me questions; make reasonable choices.
- Tool calls per chat are limited: batch steps into one run_command (a short script) instead of many small calls, and hand long or tool-heavy work to local agents (agent_spawn, or swarm_start for several in parallel), then wait with agent_status/swarm_status wait_sec instead of polling. You plan, coordinate and review.
- When finished call report(task_id="${taskId}", status="final", summary=..., content=<your complete answer>, files_changed=[...], tests=...). If you cannot finish, call report with status="blocked" and the reason.
${cwd ? `\nWORKING DIRECTORY: ${cwd}\n` : ''}
TASK:
${task}`;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Fast path in the dedicated Chrome: a new tab for this task, then the site's steps.
async function fastPath({ ded, site, cfg, prompt, chatUrl, log, model, effort, allowPro, dryRun }) {
  const page = await ded.newPage();
  try {
    const res = await site.send(page, { cfg, prompt, chatUrl, log, model, effort, allowPro, dryRun });
    if (res && typeof res === 'object' && res.dryRunOk) {
      return { page, dryRunOk: true, chatUrl: res.chatUrl, model: res.model };
    }
    const detectedModel = site.readSelectedModel ? await site.readSelectedModel(page).catch(() => null) : null;
    return { page, chatUrl: res, model: detectedModel };
  } catch (e) {
    if (!(e instanceof NeedOperator)) await page.close().catch(() => {});
    else e.page = page;
    throw e;
  }
}


// ---------------- fast path in the owner's Chrome via Browser MCP ----------------
async function bmFastPath({ cfg, prompt, chatUrl, log, model }) {
  let s;
  try { s = await BmSession.open(cfg); } catch (e) { throw new BrowserMcpError(`Browser MCP not available: ${e.message}`); }
  try {
    const url = englishUrl(chatUrl || cfg.gemweb.gemini_url);
    try { await s.newTab(url); } catch (e) {
      if (!/Timeout/i.test(e.message)) throw e;
      log(`opening the tab timed out (${e.message.slice(0, 80)}); retrying once`, 'warn');
      await s.closeOwnTabs();
      await s.newTab(url);
    }
    return await bmSend(s, { cfg, prompt, chatUrl, log, model });
  } catch (e) {
    // Browser MCP lets only the session that opened a tab close it, so the operator works in
    // this tab and the driver keeps the session (and closes the tab) to the end.
    if (e instanceof NeedOperator && s.tabId) { e.session = s; throw e; }
    await s.closeTab(); await s.closeOwnTabs(); await s.close();
    throw e;
  }
}

async function bmSend(s, { cfg, prompt, chatUrl, log, model }) {
  try {
    let st = null;
    for (let i = 0; i < 40; i++) { // up to ~30 s for the editor
      st = await s.pageState();
      if (st.editor || st.signInBtn) break;
      await sleep(750);
    }
    if (!st.signedIn && st.signInBtn) throw new Blocked('auth', 'Gemini is not signed in in your Chrome');
    if (/accounts\.google\.com/.test(st.url)) throw new Blocked('auth', `Google sign-in page shown (${st.url.slice(0, 80)})`);
    if (!st.editor) throw new NeedOperator('editor', 'prompt box not found');
    await sleep(800);
    if (model && !chatUrl) {
      try {
        await s.run(["click getByRole('button', { name: /mode|model|模式/i }).first()", 'wait 800', `click getByText(${JSON.stringify(model).replace(/^"|"$/g, "'")}, { exact: true })`, 'wait 600']);
        log(`model set: ${model}`);
      } catch (e) { await s.run(['press Escape'], { allowError: true }); throw new NeedOperator('model', `model "${model}" not selectable: ${e.message}`); }
    }
    const conn = cfg.gemweb.connector_name;
    // Custom apps only work in Task mode.
    const taskState = () => s.eval("() => { const b = [...document.querySelectorAll('button')].find((x) => /^(Task|任务)$/.test((x.innerText || '').trim())); return b ? { label: b.innerText.trim(), pressed: b.getAttribute('aria-pressed') } : null; }");
    let tb = null;
    for (let attempt = 0; attempt < 2 && !tb; attempt++) {
      if (attempt) { // sometimes the toggle never renders on first load; one reload usually brings it back
        log('Chat/Task toggle missing — reloading the page once');
        await s.run([`goto ${st.url}`, 'wait 2500'], { allowError: true });
        for (let i = 0; i < 40; i++) { if ((await s.pageState().catch(() => ({}))).editor) break; await sleep(750); }
      }
      for (let i = 0; i < 60 && !tb; i++) { tb = await taskState(); if (!tb) await sleep(750); } // renders with the rest of the toolbar; slow loads take 20-40 s
    }
    if (!tb) throw new NeedOperator('task-mode', 'Chat/Task toggle not found');
    if (tb.pressed !== 'true') await s.run([`click getByRole('button', { name: '${tb.label}', exact: true })`]);
    await sleep(500);
    // Gemini keeps unsent drafts per account: clear the box first.
    await s.run(["click getByRole('textbox').first()", 'press Meta+a', 'press Backspace', 'wait 300']);
    if (conn) {
      try {
        await s.run(['type "@"', 'wait 1000', `type "${conn.split(' ')[0]}"`, 'wait 1200', `click getByRole('menuitem', { name: '${conn.replace(/'/g, "\\'")}' })`, 'wait 500']);
      } catch (e) { throw new NeedOperator('connector', `"@${conn}" not offered — is the custom app added and enabled? (${e.message})`); }
      log(`connector selected: @${conn}`);
    }
    const n = await s.insertText(' ' + prompt);
    if (n === 'no-editor' || !(n > prompt.length / 2)) throw new NeedOperator('insert', `task text did not land in the prompt box (${n})`);
    await sleep(600);
    await s.run(['press Enter']);
    const deadline = Date.now() + 40000;
    while (Date.now() < deadline) {
      await sleep(1200);
      st = await s.pageState();
      if (/\/app\/[0-9a-f]{8,}/.test(st.url) && st.editorText < 20) return { session: s, chatUrl: st.url };
      if (chatUrl && st.generating) return { session: s, chatUrl: st.url };
    }
    throw new NeedOperator('send', `message did not go out (url ${st?.url})`);
  } catch (e) {
    // The tab is open, so Browser MCP works: a failed step means the page differs from what we expect.
    if (e instanceof BrowserMcpError) throw new NeedOperator('page', e.message);
    throw e;
  }
}

// Page handle used while waiting for the report: same calls for both browser paths.
function cdpHandle(page, site, ded) {
  return {
    kind: 'cdp',
    alive: () => !page.isClosed(),
    generating: () => site.generating(page),
    clickConfirms: (log) => site.clickConfirms(page, log),
    pendingConfirm: site.pendingConfirm ? () => site.pendingConfirm(page) : null,
    limit: () => site.limit(page),
    lastText: () => site.lastText(page),
    // last reply while nothing is pending (no tool prompt open), else null
    idleReply: site.pendingConfirm ? async () => ((await site.pendingConfirm(page)) || !(await site.replyCount(page)) ? null : (await site.lastText(page)) || null) : null,
    close: async () => { await page.close().catch(() => {}); if (ded) await ded.closeTaskTabs().catch(() => {}); },
  };
}
function bmHandle(s) {
  const warned = new Set();
  let stuckSince = 0, reloads = 0;
  return {
    kind: 'browsermcp',
    get tabId() { return s.tabId; },
    alive: () => !s.closed && !!s.tabId,
    generating: async () => (await s.pageState().catch(() => ({}))).generating === true,
    clickConfirms: async (log) => {
      let n = 0;
      const st = await s.confirmState(SEL.confirmButtons);
      // A prompt whose buttons went grey without Gemini getting the answer: reload once it has sat 40 s.
      if (st.stuck) {
        if (!stuckSince) stuckSince = Date.now();
        else if (Date.now() - stuckSince > 40000 && reloads < 3) {
          reloads++; stuckSince = 0;
          log('Gemini tool prompt stuck (buttons disabled, no answer sent) — reloading the chat', 'warn');
          const url = await s.url().catch(() => null);
          if (url) { await s.run([`goto ${url}`, 'wait 2500'], { allowError: true }); for (let i = 0; i < 30; i++) { if ((await s.confirmState(SEL.confirmButtons)).labels.length) break; await sleep(1000); } }
          return 0;
        }
      } else stuckSince = 0;
      for (const label of preferAlways(st.labels)) {
        let ok = await s.run([`click getByRole('button', { name: '${label.replace(/'/g, "\\'")}', exact: true }).last()`], { allowError: true }).then((t) => /✓ click/.test(t)).catch(() => false);
        if (!ok) ok = (await s.jsClickButton(label)) === true;
        if (ok) { n++; log(`clicked Gemini confirmation "${label}"`); await sleep(800); } else if (!warned.has(label)) { warned.add(label); log(`could not click Gemini confirmation "${label}"`, 'warn'); }
      }
      return n;
    },
    lastText: () => s.lastResponseText(),
    limit: async () => null,
    close: async () => { await s.closeTab(); await s.close(); },
    detach: () => s.close(),
  };
}

// ---------------- operator (cheap model through an agent CLI + a browser MCP; off by default) ----------------
const opProvider = (model, cfg) => (model.startsWith('codex/') ? cfg.gemweb.operator_responses_provider : cfg.gemweb.operator_provider) || 'default';
function overlayFor(model, cfg, backend) {
  const provider = opProvider(model, cfg);
  const acct = cfg?.gemweb?._account || 'default';
  const f = path.join(STATE_DIR, 'run', `operator-${backend}-${acct}-${model.replace(/[^\w.-]/g, '_')}.yml`);
  const [cmd, ...args] = backend === 'browsermcp' ? cfg.gemweb.browsermcp_command : ['npx', '-y', '@playwright/mcp@0.0.86', '--cdp-endpoint', cfg.gemweb.cdp_url];
  fs.writeFileSync(f, `- id: agent-default-model
  config:
    provider: ${provider}
    model: ${model}
    reasoningEffort: ${cfg.gemweb.operator_effort || 'low'}
- id: mcp-browser
  config:
    serverName: browser
    transport: stdio
    command: ${cmd}
    args: ${JSON.stringify(args)}
    toolCallTimeoutMs: 120000
    failOnStartupError: false
`);
  return f;
}

function operatorBrief({ mode, cfg, prompt, chatUrl, model, why, backend, tabId, site = gemini }) {
  const own = backend === 'browsermcp' ? ` This is the owner's own Chrome. Work ONLY in tab ${tabId} (run \`tab select ${tabId}\` first); never open, select or close any other tab, and do not close tab ${tabId}.` : '';
  const conn = site.connector(cfg);
  if (mode === 'diagnose') {
    return `You are a browser operator. Only operate the browser; do not analyse the task itself.${own}
A ${site.label} web conversation at ${chatUrl} has made no visible progress for several minutes.
1. ${backend === 'browsermcp' ? `Select tab ${tabId} (it shows ${site.openUrl(chatUrl)}).` : `Open ${site.openUrl(chatUrl)} in a new tab of your own.`}
2. Take a snapshot. If ${site.label} shows a confirmation for a "${conn}" tool call, click "Always allow" if offered, otherwise "Allow once" / Allow / Confirm / Continue (never "Don't allow" / Deny).
   If it is still generating, do nothing. If it shows an error ("Something went wrong") click Retry/Regenerate once.
3. Do NOT type new messages. ${backend === 'browsermcp' ? 'Leave the tab open.' : 'Close the tab you opened when done.'}
Reply with exactly one line: STATUS=<generating|clicked-confirm|retried|finished|error|login|rate-limit|unknown>|<what you saw, <=200 chars>`;
  }
  return `You are a browser operator. Only operate the browser; do not do the task yourself and do not analyse it.${own}
The fast path failed (${why}). ${backend === 'browsermcp' ? `Tab ${tabId} already shows Gemini and may hold a half-typed prompt: clear the prompt box first. Do these steps in that tab:` : 'Do these steps in a NEW tab of your own and leave other tabs alone:'}
${site.operatorSteps(cfg, model, chatUrl)}
6. Do NOT close the tab. Reply with exactly one line: CHAT_URL=<the conversation URL>
If something else blocks you reply: BLOCKED: ui-changed|<what you saw>.

TASK CARD (between the lines):
-----
${prompt}
-----`;
}

function judgeOverlay(model, cfg) {
  const provider = opProvider(model, cfg);
  const f = path.join(STATE_DIR, 'run', `judge-${model.replace(/[^\w.-]/g, '_')}.yml`);
  fs.writeFileSync(f, `- id: agent-default-model
  config:
    provider: ${provider}
    model: ${model}
    reasoningEffort: ${cfg.gemweb.operator_effort || 'low'}
`);
  return f;
}

// One-shot question to a cheap independent model (no browser); tries cfg models in order.
export async function askModel({ prompt, cfg, models, timeoutSec = 300 }) {
  const tried = [];
  for (const model of models || cfg.gemweb.operator_models) {
    const r = await runOperatorOnce({ model, brief: prompt, cfg, overlay: judgeOverlay(model, cfg), timeoutSec });
    if (r.ok) return { ...r, tried };
    tried.push(`${model}: ${r.error || 'no answer'}`.slice(0, 200));
  }
  return { ok: false, text: '', tried };
}

function runOperatorOnce({ model, brief, cfg, backend, timeoutSec = 420, overlay: givenOverlay }) {
  return new Promise((resolve) => {
    const overlay = givenOverlay || overlayFor(model, cfg, backend);
    const started = Date.now();
    const ch = spawn(expandHome(cfg.gemweb.operator_bin || 'dsh'), ['--profile', 'headless', '--patch', overlay, '--json', '--approval-policy', 'never', brief], { cwd: os.tmpdir(), stdio: ['ignore', 'pipe', 'pipe'] });
    let buf = '', final = null; const usage = { input: 0, output: 0, cached: 0, steps: 0 };
    ch.stdout.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
        if (!line.startsWith('{')) continue;
        try {
          const ev = JSON.parse(line);
          if (ev.usage) { usage.input += ev.usage.inputTokens || 0; usage.output += ev.usage.outputTokens || 0; usage.cached += ev.usage.cacheReadTokens || 0; usage.steps++; }
          if (ev.type === 'final') final = ev;
        } catch { /* */ }
      }
    });
    let err = ''; ch.stderr.on('data', (d) => { err += d; if (err.length > 20000) err = err.slice(-10000); });
    const t = setTimeout(() => ch.kill('SIGKILL'), timeoutSec * 1000);
    ch.on('error', (e) => { err += `\n${e.message}`; });
    ch.on('close', () => {
      clearTimeout(t);
      const text = (final?.text || '').trim();
      resolve({ model, text, ok: final?.reason?.kind === 'completed' && !!text, error: final?.reason?.error?.message || (final ? '' : err.split('\n').filter(Boolean).slice(-3).join(' ')), usage, secs: Math.round((Date.now() - started) / 1000) });
    });
  });
}

export function operatorCost(usage, model, cfg) {
  const p = (cfg.gemweb.operator_prices || {})[model];
  if (!p) return null;
  const fresh = Math.max(0, usage.input);
  return (fresh * p.input + usage.cached * (p.cached ?? p.input) + usage.output * p.output) / 1e6;
}

async function runOperator(opts, log, report) {
  const models = opts.cfg.gemweb.operator_models || [];
  let last = null;
  for (const model of models) {
    log(`operator ${model} (${opts.backend}): ${opts.mode === 'diagnose' ? 'diagnosing' : 'taking over the send'} (${opts.why || ''})`);
    const r = await runOperatorOnce({ model, brief: operatorBrief(opts), cfg: opts.cfg, backend: opts.backend });
    const cost = operatorCost(r.usage, model, opts.cfg);
    report(r, cost);
    log(`operator ${model}: ${r.ok ? r.text.slice(0, 300) : 'failed ' + r.error} · ${r.secs}s · ${r.usage.steps} steps · in ${r.usage.input}+${r.usage.cached} cached / out ${r.usage.output} tokens${cost != null ? ` · ~$${cost.toFixed(4)}` : ''}`, r.ok ? 'info' : 'warn');
    if (r.ok) return r;
    last = r;
  }
  return last || { ok: false, text: '', error: 'no operator models configured' };
}

// ---------------- page watcher ----------------
// When a prompt offers "Always allow", click only that (not "Allow once" of the same prompt).
export function preferAlways(labels) {
  const always = labels.filter((l) => SEL.alwaysAllow.test(l));
  return always.length ? always : labels.filter((l) => !/^(Don't allow|Deny|拒绝|不允许)$/i.test(l));
}

// What the web model did on this machine, from the server's event log (one line per tool call).
export async function toolSummary(api, id) {
  const evs = await api(`/events?task_id=${encodeURIComponent(id)}&limit=5000`).catch(() => []);
  const starts = new Map(evs.filter((e) => e.type === 'tool.start').map((e) => [e.call_id, e]));
  return evs.filter((e) => e.type === 'tool.end' && e.tool !== 'report').map((e) => {
    const s = starts.get(e.call_id);
    return `${e.denied ? 'DENIED ' : e.ok ? '' : 'ERROR '}${e.tool} ${String(s?.summary || '').replace(/\s+/g, ' ').slice(0, 140)}${e.denied && e.reason ? ` — ${String(e.reason).slice(0, 100)}` : ''}`.trim();
  });
}

// ---------------- main ----------------
export async function dispatch({ task, flags, api, waitFinal, printFinal, cfg }) {
  const timeoutSec = flags.timeout || cfg.gemweb.report_timeout_sec || 1800;
  const dryRun = !!flags.dryRun;
  const mock = dryRun || (flags.driver || cfg.gemweb.driver) === 'mock';
  let t0;
  try {
    t0 = await api('/tasks', { method: 'POST', body: { prompt: task, from: flags.from, title: flags.title, chat_url: flags.chat || null, cwd: flags.cwd || null, mock, site: siteFor(flags.site).name, account: flags.account || null } });
  } catch (e) {
    // Daily cap reached, usage-limit pause, or disabled account: stop here and say why.
    if ([400, 404, 429].includes(e.status) && e.body?.kind) { console.log(`BLOCKED: ${e.body.kind}|${e.body.error}`); return 3; }
    throw e;
  }
  const id = t0.id;
  const account = t0.account || defaultAccountName(cfg);
  process.stderr.write(`TASK_ID=${id}\n`);
  const log = (msg, level = 'info') => { process.stderr.write(`[gemweb ${id}] ${msg}\n`); api(`/tasks/${id}/update`, { method: 'POST', body: { log: msg, level } }).catch(() => {}); };
  const update = (body) => api(`/tasks/${id}/update`, { method: 'POST', body }).catch(() => {});
  if (!flags.wait && !dryRun) {
    // Detach: re-run ourselves in the background attached to this task id.
    const logf = path.join(STATE_DIR, 'run', `gemweb-${id}.log`);
    const out = fs.openSync(logf, 'a');
    const child = spawn(process.execPath, [
      process.argv[1], '__drive', id,
      ...(flags.site ? ['--site', flags.site] : []),
      ...(account ? ['--account', account] : []),
      ...(flags.chat ? ['--chat', flags.chat] : []),
      ...(flags.model ? ['--model', flags.model] : []),
      ...(flags.effort ? ['--effort', flags.effort] : []),
      ...(flags.allowPro ? ['--allow-pro'] : []),
      '--timeout', String(timeoutSec),
      ...(flags.driver ? ['--driver', flags.driver] : []),
      ...(flags.browser ? ['--browser', flags.browser] : []),
      ...(flags.keepTab ? ['--keep-tab'] : []),
      ...(flags.noOperator ? ['--no-operator'] : []),
    ], { detached: true, stdio: ['ignore', out, out], env: process.env });
    child.unref();
    console.log(id);
    return 0;
  }
  return drive({ id, task, cwd: flags.cwd || null, site: siteFor(flags.site).name, account, flags, api, waitFinal, printFinal, cfg, log, update, timeoutSec });
}

// Browser MCP errors that mean the extension/daemon is not usable at all (vs. a page-level problem).
export function browserMcpUnavailable(e) {
  return /not available|disconnected|not connected|isn't connected|is paused|extension|ECONNREFUSED|daemon/i.test(e?.message || '') && !/Timeout \d+ms exceeded/i.test(e?.message || '');
}

// Which browsers to try, in order. Default: the dedicated Chrome only. The owner's everyday Chrome
// (Browser MCP) is used only when asked for (--browser browsermcp / gemweb.browser) or, after the
// dedicated Chrome failed, when gemweb.owner_chrome_fallback is true.
export function browserOrder(flags, cfg, site = 'gemini') {
  if (site !== 'gemini') return ['cdp']; // ChatGPT runs only in the dedicated Chrome
  const want = flags.browser || cfg.gemweb.browser || 'cdp';
  if (want === 'browsermcp') return ['browsermcp', 'cdp'];
  return cfg.gemweb.owner_chrome_fallback ? ['cdp', 'browsermcp'] : ['cdp'];
}

// Puts the task into a new web chat through one browser backend; returns a page handle.
async function sendVia(backend, { id, site = gemini, cfg, prompt, chatUrl, log, model, effort, allowPro, dryRun, flags, noteOperator, account = null }) {
  if (backend === 'browsermcp') {
    try {
      const r = await bmFastPath({ cfg, prompt, chatUrl, log, model });
      log(`sent via fast path in your own Chrome (Browser MCP, tab ${r.session.tabId}) → ${r.chatUrl}`);
      return { handle: bmHandle(r.session), chatUrl: r.chatUrl, ded: null, path: 'fast' };
    } catch (e) {
      if (!(e instanceof NeedOperator)) throw e;
      const sess = e.session;
      const handle = bmHandle(sess);
      try {
        if (flags.noOperator) throw new Blocked('ui-changed', e.message);
        log(e.message, 'warn');
        const r = await runOperator({ mode: 'send', cfg, prompt, chatUrl, model, why: e.message, backend, tabId: sess.tabId }, log, noteOperator);
        const out = parseOperatorSend(r);
        return { handle, chatUrl: out, ded: null, path: 'operator' };
      } catch (err) { await handle.close(); throw err; }
    }
  }
  let ded;
  try { ded = await Dedicated.connect(cfg, id, log, { account, forceChrome: !!flags._forceChrome }); } catch (e) { throw e instanceof BrowserBlocked ? new Blocked(e.kind, e.detail) : new Blocked('browser', `dedicated Chrome [${account || 'default'}] not reachable: ${e.message.slice(0, 200)}`); }
  try {
    let r;
    try {
      r = await fastPath({ ded, site, cfg, prompt, chatUrl, log, model, effort, allowPro, dryRun });
    } catch (e) {
      // Not signed in inside the embedded browser yet: run this task in the dedicated Chrome
      // (gemweb.embedded.fallback_to_chrome, default on) and tell the owner where to sign in.
      if (!(ded.embedded && e instanceof Blocked && e.kind === 'auth' && cfg.gemweb?.embedded?.fallback_to_chrome !== false)) throw e;
      log(`${site.label} is not signed in in the embedded browser [${account || 'default'}] — using the dedicated Chrome for this task; sign in once from the Web AI Hub app (＋ ${site.label}; Google sign-in opens in a Chrome window) or run \`${loginExternalHint(site.name === 'gemini' ? 'gemini' : 'chatgpt', account)}\``, 'warn');
      await ded.closeTaskTabs().catch(() => {}); await ded.disconnect();
      return sendVia(backend, { id, site, cfg, prompt, chatUrl, log, model, effort, allowPro, dryRun, flags: { ...flags, _forceChrome: true }, noteOperator, account });
    }
    if (r.dryRunOk) {
      log(`dry-run verified (${site.label}${account && account !== 'default' ? ` [${account}]` : ''}${r.model ? `, ${r.model}` : ''})`);
      return { handle: cdpHandle(r.page, site, ded), chatUrl: r.chatUrl, model: r.model, dryRunOk: true, ded, path: 'dry-run' };
    }
    log(`sent via fast path (${ded.label}) → ${r.chatUrl}`);
    return { handle: cdpHandle(r.page, site, ded), chatUrl: r.chatUrl, model: r.model || null, ded, path: 'fast' };
  } catch (e) {
    if (!(e instanceof NeedOperator)) { await ded.closeTaskTabs().catch(() => {}); await ded.disconnect(); throw e; }
    await e.page?.close().catch(() => {});
    if (flags.noOperator) { await ded.closeTaskTabs().catch(() => {}); await ded.disconnect(); throw new Blocked('ui-changed', e.message); }
    log(e.message, 'warn');
    const before = new Set(ded.context.pages());
    const r = await runOperator({ mode: 'send', cfg, prompt, chatUrl, model, why: e.message, backend, site }, log, noteOperator);
    await ded.adoptNewPages(before).catch(() => {}); // tabs the operator opened close with the task
    let out;
    try { out = parseOperatorSend(r); } catch (err) { await ded.closeTaskTabs().catch(() => {}); await ded.disconnect(); throw err; }
    const page = ded.context.pages().find((p) => p.url().startsWith(out));
    return { handle: page ? cdpHandle(page, site, ded) : { kind: 'cdp', alive: () => false, close: () => ded.closeTaskTabs().catch(() => {}) }, chatUrl: out, ded, path: 'operator' };
  }
}

function parseOperatorSend(r) {
  if (!r.ok) throw new Blocked('operator-failed', r.error || r.text);
  if (r.text.startsWith('BLOCKED:')) { const [k, ...d] = r.text.slice(8).trim().split('|'); throw new Blocked(k.trim(), d.join('|')); }
  const m = /CHAT_URL=(\S+)/.exec(r.text);
  if (!m) throw new Blocked('operator-failed', `unexpected operator reply: ${r.text.slice(0, 200)}`);
  return m[1];
}

export async function drive({ id, task, cwd = null, site: siteName = 'gemini', account = null, flags = {}, api, waitFinal, printFinal, cfg, log, update, timeoutSec }) {
  log ||= (msg, level = 'info') => { process.stderr.write(`[gemweb ${id}] ${msg}\n`); api(`/tasks/${id}/update`, { method: 'POST', body: { log: msg, level } }).catch(() => {}); };
  update ||= (body) => api(`/tasks/${id}/update`, { method: 'POST', body }).catch(() => {});
  const scfg = cfgForAccount(cfg, account || flags.account);
  const acctName = scfg.gemweb._account;
  const started = Date.now();
  const operatorSpend = { runs: 0, input: 0, cached: 0, output: 0, usd: 0, models: [] };
  const noteOperator = (r, cost) => {
    operatorSpend.runs++; operatorSpend.input += r.usage.input; operatorSpend.cached += r.usage.cached; operatorSpend.output += r.usage.output; operatorSpend.models.push(r.model);
    if (cost != null) operatorSpend.usd += cost;
    update({ driver: { operator_runs: operatorSpend.runs, operator_tokens: { input: operatorSpend.input, cached: operatorSpend.cached, output: operatorSpend.output }, operator_cost_usd: Math.round(operatorSpend.usd * 1e6) / 1e6, operator_models: operatorSpend.models } });
  };

  // 1. slot (per-site, per-account concurrency and interval throttling)
  // Stopped while still queued (agent stop/timeout, Ctrl-C): mark the task cancelled and give back
  // the queue entry / any slot a pending acquire was just granted, instead of leaving a ghost
  // "queued" task that may hold a slot until the heartbeat sweep.
  const onQueuedSignal = async (sig) => {
    await update({ status: 'cancelled', error: `driver stopped while queued (${sig})` });
    await api(`/tasks/${id}/release`, { method: 'POST' }).catch(() => {});
    process.exit(143);
  };
  process.once('SIGTERM', onQueuedSignal); process.once('SIGINT', onQueuedSignal);
  let pos = -1;
  for (;;) {
    const a = await api(`/tasks/${id}/acquire?wait=${pos === -1 ? 0 : 50}`, { method: 'POST' });
    if (a.granted) break;
    if (a.position !== pos) { pos = a.position || 0; process.stderr.write(`[gemweb ${id}] queued #${a.position} (${a.running}/${a.limit} running${a.wait_sec ? `, next start in ${a.wait_sec}s` : ''})\n`); }
  }
  process.removeListener('SIGTERM', onQueuedSignal); process.removeListener('SIGINT', onQueuedSignal);
  let handle = null, ded = null, usedBackend = null, path_ = null;
  const heartbeat = setInterval(() => update({}), 45000);
  // Every tab this task opened in the dedicated Chrome is closed at the end, whatever happened.
  const closeTabs = async () => {
    if (flags.keepTab) { if (handle?.detach) await handle.detach().catch(() => {}); return; }
    if (handle) await handle.close().catch(() => {});
    await closeTaskTabsFor(scfg, id).catch(() => {});
  };
  // Stopped from outside (goal stop, service restart): close our own tab, mark the task cancelled
  // (the MCP server then refuses further tool calls for it) and exit.
  let signalled = false;
  const rawUpdate = update;
  update = (body) => (signalled && body.status !== 'cancelled' ? Promise.resolve() : rawUpdate(body)); // the main loop must not overwrite "cancelled"
  const onSignal = async (sig) => {
    signalled = true;
    clearInterval(heartbeat);
    await update({ status: 'cancelled', error: `driver stopped (${sig})` });
    await api(`/tasks/${id}/release`, { method: 'POST' }).catch(() => {});
    await Promise.race([closeTabs(), sleep(8000)]);
    process.exit(143);
  };
  process.once('SIGTERM', onSignal); process.once('SIGINT', onSignal);
  let lastStage = '';
  const setStage = (stage, detail = null) => {
    if (stage === lastStage && !detail) return;
    lastStage = stage;
    update({ stage, stage_detail: detail });
  };

  try {
    await update({ status: 'starting', stage: 'starting', driver: { pid: process.pid, site: siteName, account: acctName } });
    const site = siteFor(siteName);
    const prompt = composePrompt(id, task, scfg, site, cwd);
    const model = flags.model || (site.name === 'gemini' ? (scfg.gemweb.model_label || '') : '');
    const effort = flags.effort || '';
    const allowPro = !!flags.allowPro;
    const dryRun = !!flags.dryRun;
    let chatUrl = flags.chat || null;
    let verifiedModel = null;

    if ((flags.driver || scfg.gemweb.driver) === 'mock' && !dryRun) {
      // "MOCK limit" in the task simulates a usage-limit notice on the page (tests).
      if (/^MOCK limit\b/m.test(task)) throw new Blocked('rate-limit', "mock: You've reached your limit. Try again later.");
      const { mockGemini } = await import('./mock-gemini.js');
      log('mock driver: simulating Gemini over MCP (no browser)');
      await update({ status: 'dispatched', stage: 'waiting', driver: { path: 'mock', account: acctName } });
      mockGemini({ id, task, cfg: scfg }).catch((e) => log(`mock failed: ${e.message}`, 'error'));
    } else {
      setStage('sending');
      const order = browserOrder(flags, scfg, site.name);
      let firstError = null;
      let dryRunOk = false;
      for (const backend of order) {
        const last = backend === order[order.length - 1];
        try {
          const sent = await sendVia(backend, { id, site, cfg: scfg, prompt, chatUrl, log, model, effort, allowPro, dryRun, flags, noteOperator, account: acctName });
          ({ handle, chatUrl, ded, path: path_ } = sent);
          verifiedModel = sent.model || null;
          dryRunOk = !!sent.dryRunOk;
          usedBackend = backend;
          break;
        } catch (e) {
          if (e instanceof Blocked && e.kind === 'rate-limit') throw e; // the account is limited: no other browser helps
          if (backend === 'browsermcp' && e instanceof BrowserMcpError) {
            // Owner's Chrome asked for explicitly: only switch to the dedicated Chrome when Browser MCP itself is unavailable.
            if (!browserMcpUnavailable(e) || last) throw new Error(`Browser MCP (your Chrome): ${e.message.slice(0, 300)}`);
            log(`${e.message} — using the dedicated Chrome instead`, 'warn'); firstError = e; continue;
          }
          if (backend === 'cdp' && !last && e instanceof Blocked && ['auth', 'browser'].includes(e.kind)) {
            log(`${e.message} — gemweb.owner_chrome_fallback is on: trying your own Chrome (Browser MCP)`, 'warn'); firstError = e; continue;
          }
          if (firstError instanceof Blocked && e instanceof BrowserMcpError) throw firstError; // report the dedicated Chrome's problem, not the fallback's
          throw e;
        }
      }
      if (dryRunOk) {
        await update({ status: 'done', stage: 'idle', chat_url: chatUrl, driver: { path: 'dry-run', browser: usedBackend, site: site.name, account: acctName, model: verifiedModel || model || null } });
        console.log(`DRY-RUN-OK (${site.label}${acctName !== 'default' ? ` [${acctName}]` : ''}${verifiedModel ? `, ${verifiedModel}` : ''})`);
        return 0;
      }
      await update({ status: 'dispatched', stage: 'generating', chat_url: chatUrl, driver: { path: path_, browser: usedBackend, host: usedBackend === 'cdp' ? (ded?.embedded ? 'embedded' : 'chrome') : null, site: site.name, account: acctName, model: verifiedModel || model || null } });
    }

    // 2. wait for report(final); watch the page meanwhile
    const deadline = started + timeoutSec * 1000;
    let lastActivity = Date.now(), lastCalls = -1, diagnoses = 0, t = await api(`/tasks/${id}`);
    const idle = { text: null, calls: -1, since: 0 }; // ChatGPT: last reply unchanged while not generating
    const idleSec = Number(scfg.gemweb.chatgpt?.idle_sec ?? 20);
    while (!t.final && Date.now() < deadline && !['failed', 'abandoned', 'cancelled'].includes(t.status)) {
      t = await api(`/tasks/${id}/wait?wait=${handle ? (site.name === 'chatgpt' ? 5 : 15) : 50}&reports=${t.reports.length}`);
      if (t.tool_calls !== lastCalls) { lastCalls = t.tool_calls; lastActivity = Date.now(); }
      if (handle && handle.alive()) {
        const confirmed = scfg.gemweb.auto_confirm ? await handle.clickConfirms(log).catch(() => 0) : 0;
        if (confirmed) lastActivity = Date.now();
        const stillPending = handle.pendingConfirm ? await handle.pendingConfirm().catch(() => false) : false;
        const isGen = await handle.generating().catch(() => false);
        if (stillPending) {
          setStage('waiting_confirm');
        } else if (isGen) {
          lastActivity = Math.max(lastActivity, Date.now() - 60000);
          setStage('generating');
        } else if (!t.final) {
          const lim = await handle.limit?.().catch(() => null); if (lim) throw new Blocked('rate-limit', lim);
          setStage('waiting');
          // No report(final) but the model has stopped: its last reply is the answer.
          if (site.name === 'chatgpt' && handle.idleReply) {
            const txt = await handle.idleReply();
            if (!txt || txt !== idle.text || t.tool_calls !== idle.calls) { idle.text = txt; idle.calls = t.tool_calls; idle.since = Date.now(); }
            else if (Date.now() - idle.since > idleSec * 1000) {
              log(`no report call; using ChatGPT's last reply (unchanged for ${idleSec}s)`);
              await update({ final_from_page: txt });
              t = await api(`/tasks/${id}`);
              continue;
            }
          }
        }
      }
      if (!t.final && chatUrl && Date.now() - lastActivity > 6 * 60 * 1000 && diagnoses < 2 && !flags.noOperator) {
        diagnoses++; lastActivity = Date.now();
        if (usedBackend === 'browsermcp' && !handle?.tabId) continue; // the operator may only work in our own tab
        const before = ded ? new Set(ded.context.pages()) : null;
        const r = await runOperator({ mode: 'diagnose', cfg: scfg, chatUrl, why: 'no progress for 6 min', backend: usedBackend || 'cdp', tabId: handle?.tabId }, log, noteOperator);
        if (ded && before) await ded.adoptNewPages(before).catch(() => {});
        if (/STATUS=login/.test(r.text)) throw new Blocked('auth', r.text);
        if (/STATUS=rate-limit/.test(r.text)) throw new Blocked('rate-limit', r.text);
      }
    }
    t = await api(`/tasks/${id}`);
    if (t.status === 'cancelled') {
      log('task cancelled externally');
      return 143;
    }
    if (t.final) {
      await update({ status: t.final.status === 'final' ? 'done' : 'blocked', stage: 'idle' });
      t = await api(`/tasks/${id}`);
      t.tool_summary = await toolSummary(api, id);
      printFinal(t);
      if (operatorSpend.runs) process.stderr.write(`[gemweb ${id}] operator: ${operatorSpend.runs} run(s), ${operatorSpend.input}+${operatorSpend.cached} cached in / ${operatorSpend.output} out tokens\n`);
      return t.final.status === 'final' ? 0 : 3;
    }
    // timeout: fall back to the page text
    const fallback = handle && handle.alive() ? await handle.lastText().catch(() => '') : '';
    await update({ status: 'timeout', stage: 'idle', error: `no report(final) within ${timeoutSec}s` });
    process.stderr.write(`gemweb: no report(final) from ${site.label} within ${timeoutSec}s (task ${id}${chatUrl ? `, chat ${chatUrl}` : ''})\n`);
    if (fallback) console.log(`[page text fallback — ${site.label} did not call report]\n${fallback}`);
    return 4;
  } catch (e) {
    if (e instanceof Blocked) {
      // A usage-limit notice stops further dispatches for gemweb.limit_cooldown_min (server side).
      if (e.kind === 'rate-limit') await api('/web-limit', { method: 'POST', body: { task_id: id, notice: e.detail, site: siteName || 'gemini', account: acctName } }).catch(() => {});
      await update({ status: 'blocked', stage: e.kind === 'rate-limit' ? 'rate_limited' : e.kind === 'auth' ? 'auth_required' : 'blocked', error: e.message });
      console.log(e.message);
      return 3;
    }
    await update({ status: 'failed', stage: 'idle', error: e.message });
    console.error(`gemweb: ${e.message}`);
    return 4;
  } finally {
    process.off('SIGTERM', onSignal); process.off('SIGINT', onSignal);
    clearInterval(heartbeat);
    await api(`/tasks/${id}/release`, { method: 'POST' }).catch(() => {});
    await closeTabs();
    if (ded) await ded.disconnect(); // drops CDP; the dedicated Chrome keeps running
  }
}
