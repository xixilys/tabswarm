// Site adapter for the dedicated Chrome (Playwright over CDP): how to start a Gemini chat with
// the MCP connector selected, send the task card, and read the page while the task runs
// (tool-confirmation prompts, "generating", usage-limit notices). All page heuristics live here,
// so a redesign is a one-place fix (or the operator model takes over).
import { Blocked, NeedOperator } from './errors.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export function englishUrl(u) { try { const x = new URL(u); x.searchParams.set('hl', 'en'); return x.toString(); } catch { return u; } }
function loginHintFor(site, cfg) {
  const acct = cfg?.gemweb?._account;
  return acct && acct !== 'default' ? `${site.loginHint} --account ${acct}` : site.loginHint;
}

async function firstVisible(page, selector, timeout = 15000) {
  const loc = page.locator(selector);
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const n = await loc.count().catch(() => 0);
    for (let i = 0; i < n; i++) { const el = loc.nth(i); if (await el.isVisible().catch(() => false)) return el; }
    await sleep(300);
  }
  return null;
}

async function waitVisible(loc, timeout = 4000) {
  try { await loc.waitFor({ state: 'visible', timeout }); return true; } catch { return false; }
}

// Usage-limit notices. Matched only against short notice-like text (alerts, dialogs, banners, a
// short last reply), never the task text, so a task that talks about rate limits does not trip it.
export const LIMIT_RE = /(you['’]ve|you have) (reached|hit) (your|the|our)( current| daily| usage)? (limit|usage cap|usage limit|cap)|usage (cap|limit) (reached|exceeded)|reached the (current )?(usage cap|limit of messages)|too many requests|rate limit(ed)? (reached|exceeded)|limit resets|you['’]re out of (messages|uses)|detected unusual traffic|unusual traffic from your computer network|已达到.{0,12}(上限|限额|限制)|使用(上限|限额)|请求过多/i;

export function limitNotice(texts) {
  for (const t of texts || []) {
    const s = String(t || '').trim();
    if (!s || s.length > 700 || /TASK_ID:/.test(s)) continue;
    if (LIMIT_RE.test(s)) return s.replace(/\s+/g, ' ').slice(0, 300);
  }
  return null;
}

// Clicks visible, enabled buttons whose label matches `re` (preferring `always` labels) among the
// last buttons on the page. Answered prompts keep their (disabled) buttons; those are skipped.
async function clickMatching(page, { re, always, never, before }, log, siteLabel) {
  let clicked = 0;
  try {
    const buttons = page.locator('button');
    const n = await buttons.count();
    const found = [];
    for (let i = Math.max(0, n - 80); i < n; i++) {
      const b = buttons.nth(i);
      const label = ((await b.innerText().catch(() => '')) || (await b.getAttribute('aria-label').catch(() => '')) || '').trim();
      if (!re.test(label) || (never && never.test(label))) continue;
      if (!(await b.isVisible().catch(() => false))) continue;
      if (!(await b.isEnabled().catch(() => false))) continue;
      found.push({ b, label });
    }
    const alw = found.filter((f) => always && always.test(f.label));
    const want = alw.length ? alw : found;
    for (const { b, label } of want) {
      if (before) await before(b).catch(() => {});
      await b.click({ timeout: 3000 }).catch(() => {});
      clicked++; log(`clicked ${siteLabel} confirmation "${label}"`);
      await sleep(800);
    }
  } catch { /* page navigated */ }
  return clicked;
}

// ---------------------------------------------------------------- Gemini
export const gemini = {
  name: 'gemini', label: 'Gemini',
  newChatUrl: (cfg) => englishUrl(cfg.gemweb.gemini_url),
  openUrl: (chatUrl) => englishUrl(chatUrl),
  chatUrlRe: /\/app\/[0-9a-f]{8,}/,
  connector: (cfg) => cfg.gemweb.connector_name,
  loginHint: 'webhub login gemini',
  SEL: {
    signIn: 'a[href*="accounts.google.com/ServiceLogin"], a[href*="accounts.google.com/v3/signin"], a[aria-label="Sign in"]',
    editor: 'rich-textarea [contenteditable="true"], div.ql-editor[contenteditable="true"], div[contenteditable="true"][role="textbox"], textarea[aria-label]',
    send: 'button[aria-label*="Send" i], button[aria-label*="发送"], button.send-button',
    stop: 'button[aria-label*="Stop" i], button[aria-label*="停止"]',
    mentionOption: '[role="option"], [role="menuitem"], mat-option, .mat-mdc-option',
    modeButton: '[data-test-id="bard-mode-menu-button"], button[aria-label*="mode picker" i], button[aria-label*="model" i]',
    confirmButtons: /^(Always allow|Allow once|Allow|Confirm|Approve|Run|Continue|Yes|始终允许|总是允许|允许一次|允许|确认|继续|运行)$/i,
    alwaysAllow: /^(Always allow|始终允许|总是允许)$/i,
    never: /^(Don't allow|Deny|拒绝|不允许)$/i,
    taskToggle: /^(Task|任务)$/,
    response: 'model-response, message-content, .model-response-text',
    notices: '[role="alert"], [role="dialog"], [role="status"], mat-snack-bar-container, .snackbar, error-message, .error-message',
  },

  // The mode picker (2026-11): menuitemradio rows "Auto", "Everyday help / 4 Hydrogen",
  // "Deeper analysis / 4 Neon", "Code & complex work / 4 Carbon", then a "Thinking level"
  // submenu (hover) with "Low", "Medium", "High". A wanted model matches a row whose label (or a
  // line of it) equals it or ends with it, case-insensitive, so "Neon", "4 Neon" and
  // "Deeper analysis" all pick the same row. Both choices are read back before sending.
  async readModeMenu(page) {
    return page.evaluate(() => [...document.querySelectorAll('[role="menuitemradio"], [role="menuitem"]')].filter((e) => e.offsetParent).map((e, i) => ({
      i, role: e.getAttribute('role'), checked: e.getAttribute('aria-checked') === 'true', sub: e.getAttribute('aria-haspopup') === 'true',
      lines: [...e.querySelectorAll('*')].filter((x) => !x.children.length && x.textContent.trim()).map((x) => x.textContent.trim()),
      text: (e.innerText || '').replace(/\s+/g, ' ').trim(),
    })));
  },
  async selectMode(page, { model, effort, log = () => {} }) {
    const S = this.SEL;
    const want = (row, w) => { w = String(w).trim().toLowerCase(); return [row.text, ...row.lines].some((l) => { l = l.toLowerCase(); return l === w || l.endsWith(' ' + w) || l.startsWith(w + ' '); }); };
    const menuOpen = () => page.evaluate(() => [...document.querySelectorAll('[role="menuitemradio"]')].some((e) => e.offsetParent)).catch(() => false);
    const open = async () => {
      // a menu left open by the previous pick would be toggled shut by another click
      for (let i = 0; i < 3 && await menuOpen(); i++) { await page.keyboard.press('Escape').catch(() => {}); await sleep(300); }
      for (let attempt = 0; attempt < 3; attempt++) {
        const btn = await firstVisible(page, S.modeButton, 6000);
        if (!btn) throw new NeedOperator('model', 'Gemini mode picker not found');
        await btn.click();
        for (let i = 0; i < 12 && !await menuOpen(); i++) await sleep(250);
        if (await menuOpen()) { await sleep(400); return btn; } // submenu rows render a moment after the radios
        // seen live: after a thinking-level change the picker ignores clicks until the page reloads;
        // a reload is harmless on a new, empty chat
        await page.keyboard.press('Escape').catch(() => {});
        if (attempt === 1 && /\/app\/?(\?|$)/.test(new URL(page.url()).pathname + new URL(page.url()).search)) {
          log('Gemini mode picker did not open; reloading the new chat');
          await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
        }
        await sleep(600);
      }
      throw new NeedOperator('model', 'Gemini mode picker did not open');
    };
    const clickRow = (idx) => page.evaluate((k) => { const el = [...document.querySelectorAll('[role="menuitemradio"], [role="menuitem"]')].filter((e) => e.offsetParent)[k]; el?.click(); return !!el; }, idx);
    if (model) {
      await open();
      const rows = (await this.readModeMenu(page)).filter((r) => r.role === 'menuitemradio' && !/^(low|medium|high)\b/i.test(r.text));
      const hit = rows.find((r) => want(r, model));
      if (!hit) { await page.keyboard.press('Escape'); throw new Blocked('model-unavailable', `Gemini model "${model}" is not in the picker (offered: ${rows.map((r) => r.lines.slice(-1)[0] || r.text).join(', ')})`); }
      if (!hit.checked) { await clickRow(hit.i); await sleep(700); } else await page.keyboard.press('Escape');
      // the page re-renders after a switch: wait until the picker label is stable and the menu shut
      let now = null;
      for (let i = 0, prev = null; i < 12; i++) {
        await sleep(300);
        now = await this.readSelectedModel(page).catch(() => null);
        if (now && now === prev && !await menuOpen()) break;
        prev = now;
      }
      if (!now || !want({ text: now, lines: [now.replace(/^.*currently\s+/i, '')] }, (hit.lines.slice(-1)[0] || model).replace(/^\d+\s+/, ''))) throw new Blocked('model-unavailable', `Gemini model readback is "${now}" after picking "${model}"`);
      log(`Gemini model: ${now}`);
    }
    if (effort) {
      const lvl = String(effort).trim().toLowerCase();
      if (!['low', 'medium', 'high'].includes(lvl)) throw new Blocked('model-unavailable', `Gemini thinking level "${effort}" is not one of low, medium, high`);
      await open();
      let parent = (await this.readModeMenu(page)).find((r) => r.sub && /thinking/i.test(r.text));
      if (!parent) { await sleep(800); parent = (await this.readModeMenu(page)).find((r) => r.sub && /thinking/i.test(r.text)); }
      if (!parent) { await page.keyboard.press('Escape'); throw new Blocked('model-unavailable', `this Gemini model offers no thinking level (asked for "${effort}")`); }
      await page.locator('[role="menuitem"][aria-haspopup="true"]').filter({ hasText: /thinking/i }).first().hover().catch(() => {});
      await sleep(900);
      let levels = (await this.readModeMenu(page)).filter((r) => r.role === 'menuitemradio' && /^(low|medium|high)\b/i.test(r.text));
      if (!levels.length) { await clickRow(parent.i); await sleep(900); levels = (await this.readModeMenu(page)).filter((r) => r.role === 'menuitemradio' && /^(low|medium|high)\b/i.test(r.text)); }
      const hit = levels.find((r) => r.text.toLowerCase().startsWith(lvl));
      if (!hit) { await page.keyboard.press('Escape'); throw new Blocked('model-unavailable', `Gemini thinking level "${effort}" not offered (saw: ${levels.map((r) => r.text).join(', ') || 'none'})`); }
      if (!hit.checked) { await clickRow(hit.i); await sleep(700); }
      // read back: reopen, hover the submenu again, the wanted level must be checked
      await page.keyboard.press('Escape').catch(() => {}); await sleep(300);
      await open();
      await page.locator('[role="menuitem"][aria-haspopup="true"]').filter({ hasText: /thinking/i }).first().hover().catch(() => {});
      await sleep(900);
      const back = (await this.readModeMenu(page)).find((r) => r.role === 'menuitemradio' && r.checked && /^(low|medium|high)\b/i.test(r.text));
      await page.keyboard.press('Escape').catch(() => {}); await page.keyboard.press('Escape').catch(() => {});
      if (!back || !back.text.toLowerCase().startsWith(lvl)) throw new Blocked('model-unavailable', `Gemini thinking level readback is "${back?.text || 'none'}" after picking "${effort}"`);
      log(`Gemini thinking level: ${back.text.split(' ')[0]}`);
    }
  },

  async readSelectedModel(page) {
    const btn = await firstVisible(page, this.SEL.modeButton, 1200);
    if (!btn) return null;
    const txt = ((await btn.innerText().catch(() => '')) || (await btn.getAttribute('aria-label').catch(() => '')) || '').replace(/\s+/g, ' ').trim();
    return txt || null;
  },

  async send(page, { cfg, prompt, chatUrl, log, model, effort, dryRun = false }) {
    const S = this.SEL;
    await page.goto(chatUrl ? this.openUrl(chatUrl) : this.newChatUrl(cfg), { waitUntil: 'domcontentloaded', timeout: 45000 });
    await sleep(2500);
    if (/google\.com\/sorry\b/i.test(page.url())) {
      throw new Blocked('rate-limit', 'Google unusual-traffic / CAPTCHA check triggered (google.com/sorry); wait or verify manually in dedicated Chrome');
    }
    const editor = await firstVisible(page, S.editor, 20000);
    if (await this.signedOut(page)) throw new Blocked('auth', `Gemini is not signed in in the dedicated Chrome — run: ${loginHintFor(this, cfg)}`);
    if (!editor) throw new NeedOperator('editor', 'prompt box not found');
    const lim = await this.limit(page); if (lim) throw new Blocked('rate-limit', lim);
    if ((model || effort) && !chatUrl) await this.selectMode(page, { model, effort, log });
    // Custom apps only run in Task mode; the toggle renders with the toolbar (slow loads take 20-40 s).
    let taskBtn = null;
    for (let attempt = 0; attempt < 2 && !taskBtn; attempt++) {
      if (attempt) { log('Chat/Task toggle missing — reloading the page once'); await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {}); await sleep(2500); }
      const loc = page.getByRole('button', { name: S.taskToggle }).first();
      if (await waitVisible(loc, 30000)) taskBtn = loc;
    }
    if (!taskBtn) throw new NeedOperator('task-mode', 'Chat/Task toggle not found');
    if ((await taskBtn.getAttribute('aria-pressed')) !== 'true') { await taskBtn.click(); await sleep(500); }
    const ed = await firstVisible(page, S.editor, 5000) || editor;
    await ed.click();
    await page.keyboard.press('Meta+a'); await page.keyboard.press('Backspace'); // drop a leftover draft
    const conn = this.connector(cfg);
    if (conn) {
      await page.keyboard.type('@', { delay: 50 });
      await sleep(900);
      await page.keyboard.type(conn.split(' ')[0], { delay: 30 });
      await sleep(900);
      const opt = page.locator(S.mentionOption).filter({ hasText: conn }).first();
      let picked = await waitVisible(opt, 4000);
      if (picked) await opt.click({ force: true });
      else {
        const any = page.getByText(conn, { exact: false }).last();
        picked = await waitVisible(any, 1500);
        if (picked) await any.click({ force: true });
      }
      if (!picked) throw new NeedOperator('connector', `"@${conn}" not offered — is the custom app added and enabled?`);
      await sleep(400);
      log(`connector selected: @${conn}`);
    }
    if (dryRun) {
      await page.keyboard.press('Meta+a').catch(() => {});
      await page.keyboard.press('Backspace').catch(() => {});
      return { dryRunOk: true, chatUrl: page.url(), model: await this.readSelectedModel(page).catch(() => null) };
    }
    await page.keyboard.insertText(' ' + prompt);
    await sleep(500);
    const send = await firstVisible(page, S.send, 4000);
    if (send && await send.isEnabled().catch(() => false)) await send.click(); else await page.keyboard.press('Enter');
    return waitSent(this, page, ed);
  },

  // Signed-out pages carry a (hidden) ServiceLogin link plus visible "Sign in" buttons.
  async signedOut(page) {
    return (await page.locator(this.SEL.signIn).count().catch(() => 0)) > 0
      || await page.getByRole('button', { name: /^(Sign in|登录)$/ }).first().isVisible().catch(() => false)
      || /accounts\.google\.com/.test(page.url());
  },
  generating: (page) => page.locator(gemini.SEL.stop).first().isVisible().catch(() => false),
  clickConfirms(page, log) { return clickMatching(page, { re: this.SEL.confirmButtons, always: this.SEL.alwaysAllow, never: this.SEL.never }, log, 'Gemini'); },
  async pendingConfirm(page) {
    const S = this.SEL;
    return page.evaluate(([src, flags, nsrc]) => {
      const re = new RegExp(src, flags), nre = new RegExp(nsrc, flags);
      return [...document.querySelectorAll('button')].some((b) => b.offsetParent && !b.disabled && re.test((b.innerText || b.getAttribute('aria-label') || '').trim()) && !nre.test((b.innerText || '').trim()));
    }, [S.confirmButtons.source, 'i', S.never.source]).catch(() => false);
  },
  async lastText(page) {
    try { const loc = page.locator(this.SEL.response); const n = await loc.count(); return n ? (await loc.nth(n - 1).innerText()).trim() : ''; } catch { return ''; }
  },
  async limit(page) {
    if (/google\.com\/sorry\b/i.test(page.url())) {
      return 'Google unusual-traffic / CAPTCHA check (google.com/sorry)';
    }
    const texts = await page.evaluate(([sel, resp]) => {
      const out = [...document.querySelectorAll(sel)].filter((e) => e.offsetParent).map((e) => e.innerText);
      const r = document.querySelectorAll(resp); if (r.length) out.push(r[r.length - 1].innerText);
      return out;
    }, [this.SEL.notices, this.SEL.response]).catch(() => []);
    return limitNotice(texts);
  },
  operatorSteps(cfg, model, chatUrl) {
    const conn = this.connector(cfg);
    return `1. Open ${chatUrl ? this.openUrl(chatUrl) : this.newChatUrl(cfg)} and wait ~3s. If a sign-in page or "Sign in" button is shown, stop and reply: BLOCKED: auth|<what you saw>.
${model && !chatUrl ? `2. Open the model/mode picker and select the item whose visible label is exactly "${model}". If it is not offered reply BLOCKED: model-unavailable|<labels you saw>.\n` : '2. Keep the current model.\n'}3. Below the prompt box switch the "Chat | Task" toggle to Task. Click the prompt box, type "@" and pick the app named "${conn}" from the menu. If no such app is offered reply BLOCKED: connector-missing|<apps you saw>.
4. Insert the task card below into the prompt box exactly as given (browser_type is fine), then send it (Send button or Enter).
5. Wait until the URL looks like https://gemini.google.com/app/<id> and the message is visible in the conversation. Do not wait for the answer.`;
  },
};

// Sent = the page shows a conversation URL (a new chat gets one once sent) and the prompt box
// has been emptied.
async function waitSent(site, page, editor) {
  const deadline = Date.now() + 40000;
  while (Date.now() < deadline) {
    const u = page.url();
    if (site.chatUrlRe.test(u)) {
      const left = (await editor.innerText().catch(() => '')).trim();
      if (left.length < 20) return u;
    }
    const lim = await site.limit(page); if (lim) throw new Blocked('rate-limit', lim);
    await sleep(700);
  }
  throw new NeedOperator('send', `message did not go out (url ${page.url()})`);
}

// ---------------------------------------------------------------- ChatGPT
// Minimal question/answer: every task is a new chat with the custom MCP server picked by "@<name>"
// (added once by the owner, see README); one prompt is sent; the answer is the report(final) call,
// or, if the model never calls report, its last reply once it stops generating.
export const chatgpt = {
  name: 'chatgpt', label: 'ChatGPT',
  newChatUrl: (cfg) => cfg.gemweb.chatgpt?.url || 'https://chatgpt.com/',
  openUrl: (u) => u,
  chatUrlRe: /\/c\/[0-9a-zA-Z-]{8,}/,
  connector: (cfg) => cfg.gemweb.chatgpt?.connector_name ?? cfg.gemweb.connector_name,
  loginHint: 'webhub login chatgpt',
  SEL: {
    editor: '#prompt-textarea, div.ProseMirror[contenteditable="true"], div[contenteditable="true"][role="textbox"], textarea[name="prompt-textarea"]',
    send: '[data-testid="send-button"], #composer-submit-button, button[aria-label*="Send" i], button[aria-label*="发送"]',
    stop: '[data-testid="stop-button"], button[aria-label*="Stop" i], button[aria-label*="停止"]',
    login: '[data-testid="login-button"], [data-testid="signup-button"]',
    modelSwitcher: '[data-testid="model-switcher-dropdown-button"], button[aria-label*="选择 ChatGPT 模型"], button[aria-label*="Model selector" i], button[aria-label*="Choose a model" i]',
    modelMenuItem: '[role="menuitem"], [role="menuitemradio"], [role="option"], [role="menu"] button, [data-radix-popper-content-wrapper] button',
    // the "@" menu: older builds use role=option; 2026-11 builds use plain buttons (name + description)
    mentionOption: '[role="option"], [role="menuitem"], [role="listbox"] [role="button"], button',
    // Write-type tool calls ask first (Developer mode); the answer can be remembered for the chat.
    confirmButtons: /^(Confirm|Allow|Approve|Always allow|Allow once|Allow for this chat|确认|允许|批准|始终允许|允许一次)$/i,
    alwaysAllow: /^(Always allow|Allow for this chat|始终允许)$/i,
    never: /^(Deny|Decline|Cancel|Don't allow|Reject|拒绝|取消|不允许)$/i,
    remember: /remember|记住/i,
    response: '[data-message-author-role="assistant"]',
    notices: '[role="alert"], [role="dialog"], [role="status"], [data-testid*="toast"], .toast-root',
  },

  async readSelectedModel(page) {
    const btn = await firstVisible(page, this.SEL.modelSwitcher, 1200);
    if (!btn) return null;
    const raw = (await btn.innerText().catch(() => '')) || (await btn.getAttribute('aria-label').catch(() => '')) || '';
    const cleaned = raw.replace(/\s+/g, ' ').trim();
    return cleaned || null;
  },

  // With the model menu open: move the reasoning-level slider to the level labelled `want`
  // (lower-case). Returns the label, or null when there is no such slider/level. Never stops on a
  // Pro level unless allowed; the original level is restored when `want` is not found.
  async selectEffortLevel(page, want, { allowPro = false } = {}) {
    const slider = page.locator('[role="slider"]').first();
    if (!(await slider.isVisible().catch(() => false))) return null;
    const read = () => page.evaluate(() => {
      const el = document.querySelector('[data-effort-only="true"]');
      return { label: (el?.innerText || '').trim(), pro: el?.getAttribute('data-pro') === 'true' };
    });
    const min = Number(await slider.getAttribute('aria-valuemin')) || 0;
    const max = Number(await slider.getAttribute('aria-valuemax'));
    const start = Number(await slider.getAttribute('aria-valuenow'));
    if (!Number.isFinite(max) || !Number.isFinite(start)) return null;
    const go = async (v) => {
      await slider.focus();
      await page.keyboard.press('Home');
      for (let i = min; i < v; i++) await page.keyboard.press('ArrowRight');
      await sleep(250);
    };
    for (let v = min; v <= max; v++) {
      await go(v);
      const { label, pro } = await read();
      if (label.toLowerCase() !== want) continue;
      if ((pro || /\bpro\b/i.test(label)) && !allowPro) { await go(start); throw new Blocked('model-guard', `"${label}" is a Pro level; pass --allow-pro to use Pro quota`); }
      return label;
    }
    await go(start);
    return null;
  },

  async verifyAndSelectModel(page, { cfg, model, effort, allowPro = false, chatUrl = null, log = () => {} }) {
    const current = await this.readSelectedModel(page);
    const proAllowed = allowPro || cfg?.gemweb?.chatgpt?.allow_pro === true;
    if (!model) {
      if (!chatUrl && !proAllowed && current && /\bpro\b/i.test(current)) {
        throw new Blocked('model-guard', `ChatGPT is set to a Pro model ("${current}"); pass --model "<exact label>" or --allow-pro to use Pro quota`);
      }
      if (current) log(`ChatGPT model: ${current}`);
      return current;
    }

    const btn = await firstVisible(page, this.SEL.modelSwitcher, 4000);
    if (!btn) throw new Blocked('model-unavailable', 'ChatGPT model selector not found');
    await btn.click();
    await sleep(450);

    const items = page.locator(this.SEL.modelMenuItem);
    const count = await items.count().catch(() => 0);
    const want = String(model).trim().toLowerCase();
    const seenLabels = [];
    let matched = null;
    let matchedText = '';
    for (let i = 0; i < count; i++) {
      const el = items.nth(i);
      if (!(await el.isVisible().catch(() => false))) continue;
      const full = (await el.innerText().catch(() => '')).replace(/\s+/g, ' ').trim();
      const firstLine = ((await el.innerText().catch(() => '')).split('\n')[0] || '').trim();
      if (firstLine) seenLabels.push(firstLine);
      if (full.toLowerCase() === want || firstLine.toLowerCase() === want) {
        matched = el;
        matchedText = full;
        break;
      }
    }
    if (!matched) {
      // Current ChatGPT picker: reasoning levels (Instant / Medium / High / Extra High / Pro) are an
      // ARIA slider at the top of the menu, not menu items. Step through it reading the label.
      const effortLabel = await this.selectEffortLevel(page, want, { allowPro: proAllowed }).catch((e) => { if (e instanceof Blocked) throw e; return null; });
      if (effortLabel) {
        await page.keyboard.press('Escape').catch(() => {});
        await sleep(250);
        const rb = await this.readSelectedModel(page);
        log(`ChatGPT model: ${rb || effortLabel}`);
        return rb || effortLabel;
      }
      await page.keyboard.press('Escape').catch(() => {});
      throw new Blocked('model-unavailable', `ChatGPT model "${model}" not offered (visible: ${seenLabels.slice(0, 8).join(', ') || 'none'})`);
    }
    const disabled = (await matched.getAttribute('aria-disabled').catch(() => null)) === 'true'
      || !(await matched.isEnabled().catch(() => true));
    if (disabled || /locked|已锁定|limit|限额|达到使用/i.test(matchedText)) {
      await page.keyboard.press('Escape').catch(() => {});
      throw new Blocked('quota', `ChatGPT model "${model}" is locked or at quota (${matchedText})`);
    }
    await matched.click();
    await sleep(450);

    if (effort) {
      const effStr = String(effort).trim().toLowerCase();
      const sliders = page.locator('input[type="range"], [role="slider"]');
      if (await sliders.first().isVisible().catch(() => false) && /^[1-5]$/.test(effStr)) {
        const slider = sliders.first();
        await slider.evaluate((el, v) => {
          el.value = v;
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
        }, effStr).catch(() => {});
        await sleep(300);
      } else {
        const effLoc = page.locator(this.SEL.modelMenuItem).filter({ hasText: new RegExp(`^\\s*${effStr.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`, 'i') }).first();
        if (await waitVisible(effLoc, 1000)) {
          await effLoc.click();
          await sleep(300);
        } else {
          await page.keyboard.press('Escape').catch(() => {});
          throw new Blocked('model-unavailable', `ChatGPT effort "${effort}" not selectable`);
        }
      }
    }

    await page.keyboard.press('Escape').catch(() => {});
    await sleep(250);
    let readback = await this.readSelectedModel(page);
    if (!readback || !readback.toLowerCase().includes(want)) {
      await btn.click().catch(() => {});
      await sleep(300);
      const checked = page.locator('[aria-checked="true"], [data-state="checked"]');
      const cn = await checked.count().catch(() => 0);
      for (let i = 0; i < cn; i++) {
        const t = (await checked.nth(i).innerText().catch(() => '')).replace(/\s+/g, ' ').trim();
        if (t.toLowerCase().includes(want)) { readback = t; break; }
      }
      await page.keyboard.press('Escape').catch(() => {});
    }
    if (!readback || !readback.toLowerCase().includes(want)) {
      throw new Blocked('model-unavailable', `ChatGPT model readback mismatch: expected "${model}", got "${readback || 'none'}"`);
    }
    log(`ChatGPT model verified: ${readback}`);
    return readback;
  },

  async waitCloudflare(page, cfg = null) {
    for (let i = 0; i < 30; i++) {
      if (!/just a moment|attention required|请稍候/i.test(await page.title().catch(() => ''))) return;
      await sleep(1000);
    }
    throw new Blocked('browser', `ChatGPT stays on the Cloudflare check ("Just a moment…") in the dedicated Chrome — open it once with: ${loginHintFor(this, cfg)}`);
  },

  async signedOut(page) {
    if (/auth\.openai\.com|\/auth\/login/.test(page.url())) return true;
    if (await page.locator(this.SEL.login).first().isVisible().catch(() => false)) return true;
    return page.getByRole('button', { name: /^(Log in|登录)$/ }).first().isVisible().catch(() => false);
  },

  async send(page, { cfg, prompt, chatUrl, log, model, effort, allowPro = false, dryRun = false }) {
    const S = this.SEL;
    await page.goto(chatUrl ? this.openUrl(chatUrl) : this.newChatUrl(cfg), { waitUntil: 'domcontentloaded', timeout: 45000 });
    await this.waitCloudflare(page, cfg);
    await sleep(1500);
    const editor = await firstVisible(page, S.editor, 25000);
    if (await this.signedOut(page)) throw new Blocked('auth', `ChatGPT is not signed in in the dedicated Chrome — run: ${loginHintFor(this, cfg)}`);
    if (!editor) throw new Blocked('ui-changed', 'ChatGPT prompt box not found');
    const lim = await this.limit(page); if (lim) throw new Blocked('rate-limit', lim);
    const verifiedModel = await this.verifyAndSelectModel(page, { cfg, model, effort, allowPro, chatUrl, log });
    await editor.click();
    await page.keyboard.press('Meta+a'); await page.keyboard.press('Backspace');
    const conn = this.connector(cfg);
    if (conn) {
      await page.keyboard.type('@', { delay: 50 }); await sleep(800);
      await page.keyboard.type(conn.split(' ')[0], { delay: 30 }); await sleep(1000);
      const exact = new RegExp(`^\\s*${conn.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`);
      const opt = page.locator(S.mentionOption).filter({ has: page.getByText(exact) }).first();
      if (!(await waitVisible(opt, 4000))) {
        await page.keyboard.press('Escape').catch(() => {});
        throw new Blocked('connector-missing', `"@${conn}" is not offered in ChatGPT — add the custom MCP server once (README: "ChatGPT")`);
      }
      await opt.click(); await sleep(400);
      log(`connector selected: @${conn}`);
    }
    if (dryRun) {
      await page.keyboard.press('Escape').catch(() => {});
      await page.keyboard.press('Meta+a').catch(() => {});
      await page.keyboard.press('Backspace').catch(() => {});
      return { dryRunOk: true, chatUrl: page.url(), model: verifiedModel };
    }
    await page.keyboard.insertText(' ' + prompt);
    await sleep(500);
    const send = await firstVisible(page, S.send, 4000);
    if (send && await send.isEnabled().catch(() => false)) await send.click(); else await page.keyboard.press('Enter');
    try { return await waitSent(this, page, editor); } catch (e) { if (e instanceof NeedOperator) throw new Blocked('ui-changed', e.message); throw e; }
  },

  generating: (page) => page.locator(chatgpt.SEL.stop).first().isVisible().catch(() => false),
  clickConfirms(page, log) {
    const S = this.SEL;
    // tick "Remember …" next to the prompt first so later calls of that tool in this chat don't ask
    const before = async () => {
      const loc = page.getByRole('checkbox', { name: S.remember });
      const n = await loc.count().catch(() => 0);
      for (let i = 0; i < n; i++) { const c = loc.nth(i); if (await c.isVisible().catch(() => false) && !(await c.isChecked().catch(() => true))) await c.check({ timeout: 2000 }).catch(() => {}); }
    };
    return clickMatching(page, { re: S.confirmButtons, always: S.alwaysAllow, never: S.never, before }, log, 'ChatGPT');
  },
  async pendingConfirm(page) {
    const S = this.SEL;
    return page.evaluate(([src, flags, nsrc]) => { const re = new RegExp(src, flags), nre = new RegExp(nsrc, flags); return [...document.querySelectorAll('button')].some((b) => b.offsetParent && !b.disabled && re.test((b.innerText || b.getAttribute('aria-label') || '').trim()) && !nre.test((b.innerText || '').trim())); }, [S.confirmButtons.source, 'i', S.never.source]).catch(() => false);
  },
  async replyCount(page) { return page.locator(this.SEL.response).count().catch(() => 0); },
  async lastText(page) {
    try { const loc = page.locator(this.SEL.response); const n = await loc.count(); return n ? (await loc.nth(n - 1).innerText()).trim() : ''; } catch { return ''; }
  },
  async limit(page) {
    if (/google\.com\/sorry\b/i.test(page.url())) {
      return 'Google unusual-traffic / CAPTCHA check (google.com/sorry)';
    }
    const texts = await page.evaluate(([sel, resp]) => {
      const out = [...document.querySelectorAll(sel)].filter((e) => e.offsetParent).map((e) => e.innerText);
      const r = document.querySelectorAll(resp); if (r.length) out.push(r[r.length - 1].innerText);
      return out;
    }, [this.SEL.notices, this.SEL.response]).catch(() => []);
    return limitNotice(texts);
  },
};

export const SITES = { gemini, chatgpt };
export function siteFor(name) {
  const s = SITES[String(name || 'gemini').toLowerCase()];
  if (!s) throw Object.assign(new Error(`unknown site "${name}" (${Object.keys(SITES).join('|')})`), { status: 404 });
  return s;
}
