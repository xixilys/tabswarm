// Browser MCP backend: drives the owner's everyday Chrome (already signed in to Google)
// through the Browser MCP extension + daemon (`@browsermcp/mcp`, one `browser` tool that
// takes command lines). Each gemweb task gets its own MCP session and its own background
// tab; Browser MCP only lets a session close tabs it opened, so the owner's tabs are safe.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');
// JS snippet (no double quotes, safe inside eval "...") that decodes a base64 UTF-8 string.
const decodeJs = (v) => `new TextDecoder().decode(Uint8Array.from(atob('${b64(v)}'), (c) => c.charCodeAt(0)))`;

export class BrowserMcpError extends Error {}

export class BmSession {
  static async open(cfg) {
    const [command, ...args] = cfg.gemweb.browsermcp_command;
    const transport = new StdioClientTransport({ command, args, stderr: 'ignore', env: { ...process.env } });
    const client = new Client({ name: 'gemweb', version: '0.1.0' });
    await client.connect(transport);
    return new BmSession(client);
  }

  constructor(client) { this.client = client; this.tabId = null; this.closed = false; }

  // Runs command lines; returns the text output. Throws BrowserMcpError on a failed step.
  async run(lines, { allowError = false } = {}) {
    const commands = (this.tabId ? [`tab select ${this.tabId}`] : []).concat(lines).join('\n');
    const r = await this.client.callTool({ name: 'browser', arguments: { commands } }, undefined, { timeout: 180000 });
    const text = (r.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');
    if (r.isError && !allowError) throw new BrowserMcpError(text.split('\n').filter((l) => /^✗|Allow|paused|disconnected|isn't|not /.test(l)).join(' ').slice(0, 400) || text.slice(0, 400));
    return text;
  }

  // Runs a JS function in the page and returns its JSON value.
  async eval(fnSource) {
    if (fnSource.includes('"')) throw new Error('eval source must not contain double quotes');
    const text = await this.run([`eval "${fnSource.replace(/\s*\n\s*/g, ' ')}"`]);
    const lines = text.split('\n');
    const i = lines.findIndex((l) => l.startsWith('✓ eval'));
    const out = [];
    for (const l of lines.slice(i + 1)) { if (/^(Page: |✓ |✗ )/.test(l)) break; out.push(l); }
    const raw = out.join('\n').trim();
    try { return JSON.parse(raw); } catch { return raw; }
  }

  async newTab(url) {
    const text = await this.run([`tab new ${url}`]);
    const m = /tab new \S+ — tab (\d+)/.exec(text) || /tab (\d+)/.exec(text);
    if (!m) throw new BrowserMcpError(`could not open a tab: ${text.slice(0, 200)}`);
    this.tabId = m[1];
    return this.tabId;
  }

  async url() { return this.eval('() => location.href'); }

  async closeTab() {
    if (!this.tabId) return;
    await this.run([`tab close ${this.tabId}`], { allowError: true }).catch(() => {});
    this.tabId = null;
  }

  // Closes every tab this session opened (e.g. one whose "tab new" timed out before we learned its id).
  async closeOwnTabs() {
    const text = await this.client.callTool({ name: 'browser', arguments: { commands: 'tab list' } }, undefined, { timeout: 30000 }).then((r) => (r.content || []).map((c) => c.text).join('\n')).catch(() => '');
    for (const m of text.matchAll(/^\*?\s*(\d+) .*\(yours\)\s*$/gm)) {
      await this.client.callTool({ name: 'browser', arguments: { commands: `tab close ${m[1]}` } }, undefined, { timeout: 30000 }).catch(() => {});
    }
    if (this.tabId && text.includes(this.tabId)) this.tabId = null;
  }

  async close() { if (this.closed) return; this.closed = true; await this.client.close().catch(() => {}); }

  // ---- Gemini helpers (all page heuristics in plain JS so one eval per poll) ----
  static editorCss = 'rich-textarea [contenteditable=true], div.ql-editor[contenteditable=true], div[contenteditable=true][role=textbox]';

  async pageState() {
    return this.eval(`() => {
      const ed = [...document.querySelectorAll('${BmSession.editorCss}')].find((e) => e.offsetParent);
      const signedIn = !!document.querySelector('a[href*=SignOutOptions], a[aria-label*=Google][href*=accounts]');
      const signInBtn = [...document.querySelectorAll('a,button')].some((b) => /^(Sign in|登录)$/.test((b.innerText || '').trim()) && b.offsetParent);
      const stop = [...document.querySelectorAll('button')].some((b) => /stop|停止/i.test(b.getAttribute('aria-label') || '') && b.offsetParent);
      return { url: location.href, editor: !!ed, editorText: ed ? ed.innerText.trim().length : -1, signedIn, signInBtn, generating: stop, ready: document.readyState };
    }`);
  }

  async insertText(text) {
    return this.eval(`() => {
      const ed = [...document.querySelectorAll('${BmSession.editorCss}')].find((e) => e.offsetParent);
      if (!ed) return 'no-editor';
      ed.focus();
      const sel = window.getSelection(); sel.selectAllChildren(ed); sel.collapseToEnd();
      const t = ${decodeJs(text)};
      const before = ed.innerText.length;
      document.execCommand('insertText', false, t);
      if (ed.innerText.length - before < t.length / 2) {
        const dt = new DataTransfer(); dt.setData('text/plain', t);
        ed.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
      }
      return ed.innerText.length;
    }`);
  }

  // Clicks the last visible button whose text is exactly `label` from page JS (fallback when a
  // locator click fails, e.g. the prompt is outside the viewport of a background tab).
  async jsClickButton(label) {
    return this.eval(`() => { const want = ${decodeJs(label)}; const b = [...document.querySelectorAll('button')].filter((x) => x.offsetParent && !x.disabled && x.getAttribute('aria-disabled') !== 'true' && (x.innerText || x.getAttribute('aria-label') || '').trim() === want).pop(); if (!b) return false; b.scrollIntoView({ block: 'center' }); b.click(); return true; }`).catch(() => false);
  }

  async lastResponseText() {
    const v = await this.eval(`() => { const r = document.querySelectorAll('model-response, message-content, .model-response-text'); return r.length ? r[r.length - 1].innerText.slice(-20000) : ''; }`).catch(() => '');
    return typeof v === 'string' ? v : '';
  }

  // Labels of visible, clickable confirmation buttons Gemini shows before running a tool.
  // Answered prompts stay on the page with their buttons disabled; those are skipped.
  // stuck: a disabled prompt is the last thing in the chat and Gemini shows "Waiting for your input" —
  // the click was swallowed (seen once with "Always allow"); a reload brings the prompt back clickable.
  async confirmState(re) {
    const st = await this.eval(`() => { const bs = [...document.querySelectorAll('button')].filter((b) => b.offsetParent).map((b) => ({ l: (b.innerText || b.getAttribute('aria-label') || '').trim(), d: b.disabled || b.getAttribute('aria-disabled') === 'true' })).filter((x) => x.l && x.l.length < 30); const tail = (document.querySelector('main') || document.body).innerText.slice(-800); return { bs, waiting: /Waiting for your input|等待你的输入|等待您的输入/.test(tail), answered: tail.lastIndexOf('You said') > tail.lastIndexOf('Let Gemini use') }; }`).catch(() => null);
    if (!st || !Array.isArray(st.bs)) return { labels: [], stuck: false };
    const m = st.bs.filter((b) => re.test(b.l));
    const labels = [...new Set(m.filter((b) => !b.d).map((b) => b.l))];
    return { labels, stuck: !labels.length && m.some((b) => b.d) && st.waiting && !st.answered };
  }

  async confirmLabels(re) { return (await this.confirmState(re)).labels; }

}

export { decodeJs };
