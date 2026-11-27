// Fake ChatGPT web page for offline tests of `webhub --site chatgpt` in dedicated Chrome.
// Supports: #prompt-textarea, "@" menu with custom MCP server, send/stop, confirmation card with
// Deny/Confirm + "Remember", assistant messages, /c/<id> URLs & follow-ups, plus optional model
// picker (`state.picker = true`, `state.defaultModel`) to test Pro guard, --model, and --dry-run.
//   mode: 'ok' | 'limit' | 'signedout' | 'noconnector'
import http from 'node:http';
import crypto from 'node:crypto';

const PAGE = ({ mode, picker, defaultModel }) => `<!doctype html><html><head><meta charset="utf-8"><title>ChatGPT</title></head><body>
<main>
${picker ? `<div id="model-wrap">
  <button type="button" data-testid="model-switcher-dropdown-button" id="model-btn" aria-label="Choose a model">${defaultModel}</button>
  <div id="model-menu" role="menu" style="display:none">
    <div role="menuitem" data-model-picker-view-toggle="true"><span data-effort-only="true" data-pro="false" id="effort-label">Medium</span>
      <span role="slider" tabindex="0" id="effort" style="display:inline-block;width:80px;height:8px;background:#888" aria-valuemin="0" aria-valuemax="4" aria-valuenow="1"></span></div>
    <button type="button" role="menuitemradio" aria-checked="${defaultModel === 'GPT-6.2 Thinking'}">GPT-6.2 Thinking</button>
    <button type="button" role="menuitemradio" aria-checked="${defaultModel === 'GPT-6.2 Pro'}">GPT-6.2 Pro</button>
    <button type="button" role="menuitemradio" aria-checked="${defaultModel === 'GPT-6.2 Instant'}">GPT-6.2 Instant</button>
  </div>
</div>` : ''}
<div id="thread"></div>
${mode === 'signedout' ? '<button data-testid="login-button">Log in</button>' : ''}
<form id="composer" onsubmit="return false">
  <div id="prompt-textarea" contenteditable="true" role="textbox" style="min-height:40px;border:1px solid #888"></div>
  <div id="menu" style="display:none"><div>Plugins</div>${mode === 'noconnector' ? '' : '<button type="button" id="other"><span>Local Agents Mac</span> <span>other plugin</span></button><button type="button" id="app"><span>Local Projects</span> <span>Files, search, commands and git</span></button>'}</div>
  <button data-testid="send-button" id="send" aria-label="Send prompt">Send</button>
  <button data-testid="stop-button" id="stop" aria-label="Stop streaming" style="display:none">Stop</button>
</form></main>
<script>
const $ = (id) => document.getElementById(id);
const ed = $('prompt-textarea');
let mention = false;
if ($('effort')) {
  // reasoning-level slider like the current ChatGPT picker (keyboard driven)
  const LEVELS = ['Instant', 'Medium', 'High', 'Extra High', 'Pro'];
  const sl = $('effort');
  const setLevel = (v) => {
    v = Math.max(0, Math.min(4, v)); sl.setAttribute('aria-valuenow', String(v));
    $('effort-label').innerText = LEVELS[v]; $('effort-label').setAttribute('data-pro', String(v === 4));
    $('model-btn').innerText = LEVELS[v];
  };
  sl.addEventListener('keydown', (e) => {
    const v = Number(sl.getAttribute('aria-valuenow'));
    if (e.key === 'Home') setLevel(0); else if (e.key === 'End') setLevel(4);
    else if (e.key === 'ArrowRight') setLevel(v + 1); else if (e.key === 'ArrowLeft') setLevel(v - 1);
  });
}
if ($('model-btn')) {
  $('model-btn').addEventListener('click', () => {
    $('model-menu').style.display = $('model-menu').style.display === 'none' ? 'block' : 'none';
  });
  for (const item of $('model-menu').querySelectorAll('button')) {
    item.addEventListener('click', () => {
      $('model-btn').innerText = item.innerText;
      for (const b of $('model-menu').querySelectorAll('button')) b.setAttribute('aria-checked', String(b === item));
      $('model-menu').style.display = 'none';
    });
  }
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && $('model-menu')) $('model-menu').style.display = 'none';
  });
}
ed.addEventListener('input', () => { $('menu').style.display = /@\\w*$/.test(ed.innerText) ? 'block' : 'none'; });
if ($('app')) {
  $('app').addEventListener('mousedown', (e) => e.preventDefault());
  $('app').addEventListener('click', () => {
    ed.innerText = ed.innerText.replace(/@\\w*$/, ''); mention = true; $('menu').style.display = 'none';
    const r = document.createRange(); r.selectNodeContents(ed); r.collapse(false); const s = getSelection(); s.removeAllRanges(); s.addRange(r);
  });
}
function add(html, role) { const d = document.createElement('div'); if (role) d.setAttribute('data-message-author-role', role); d.innerHTML = html; $('thread').appendChild(d); return d; }
const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
async function send() {
  const text = ed.innerText;
  const m = /\\/c\\/([0-9a-f]+)/.exec(location.pathname);
  const model = $('model-btn') ? $('model-btn').innerText : null;
  const r = await fetch('/api/send', { method: 'POST', body: JSON.stringify({ text, mention, chat: m?.[1] || null, model }) }).then((x) => x.json());
  history.pushState({}, '', '/c/' + r.chat);
  ed.innerText = '';
  add(esc(text.slice(0, 60)), 'user');
  if (r.limit) { add('<div role="alert">You\\'ve hit your usage limit. Try again later.</div>'); return; }
  $('stop').style.display = '';
  const card = add('Local Projects wants to use a tool. <label><input type="checkbox" id="rem"> Remember for this conversation</label> <button class="c">Deny</button><button class="c">Confirm</button>');
  for (const b of card.querySelectorAll('button')) b.addEventListener('click', async () => {
    const remember = card.querySelector('#rem').checked;
    card.remove();
    await fetch('/api/confirm', { method: 'POST', body: JSON.stringify({ chat: r.chat, turn: r.turn, answer: b.innerText, remember }) });
    const poll = setInterval(async () => { const s = await fetch('/api/state?chat=' + r.chat + '&turn=' + r.turn).then((x) => x.json()); if (s.done) { clearInterval(poll); $('stop').style.display = 'none'; add(esc(s.reply), 'assistant'); } }, 400);
  });
}
$('send').addEventListener('click', send);
</script></body></html>`;

export async function startFakeChatgpt({ port = 0, mode = 'ok', picker = false, defaultModel = 'GPT-6.2 Thinking', runMock }) {
  const chats = new Map();
  const state = { mode, picker, defaultModel, loads: 0, sends: [], confirms: [] };
  const srv = http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://x');
    const body = req.method === 'POST' ? JSON.parse(await new Promise((r) => { let b = ''; req.on('data', (c) => { b += c; }); req.on('end', () => r(b || '{}')); })) : {};
    // stand-ins for an OAuth relay (auth.openai.com) and a server-side redirect to Google's sign-in
    if (u.pathname === '/oauth-popup' || u.pathname === '/to-google') {
      res.writeHead(302, { location: 'https://accounts.google.com/o/oauth2/v2/auth?client_id=etest' }); return res.end();
    }
    const json = (o) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
    if (u.pathname === '/api/send') {
      const chat = body.chat || crypto.randomBytes(8).toString('hex');
      const existing = chats.get(chat) || { turns: [] };
      const turn = existing.turns.length;
      const id = /task_id="([^"]+)"/.exec(body.text)?.[1] || null;
      existing.turns.push({ id, text: body.text, done: false, started: false, reply: '' });
      chats.set(chat, existing);
      state.sends.push({ chat, turn, id, mention: body.mention, model: body.model, text: body.text });
      return json({ chat, turn, limit: state.mode === 'limit' });
    }
    if (u.pathname === '/api/confirm') {
      const existing = chats.get(body.chat);
      const t = existing?.turns?.[body.turn ?? 0];
      state.confirms.push({ answer: body.answer, remember: body.remember, chat: body.chat, turn: body.turn });
      if (t && body.answer === 'Confirm' && !t.started) {
        t.started = true;
        runMock({ id: t.id, task: t.text }).then(
          (r) => { t.done = true; t.reply = r?.reported === false ? `I wrote the file and ran the check.\n${(r.notes || []).join('\n')}` : 'Done — I reported the result.'; },
          (e) => { t.done = true; t.reply = 'mock failed: ' + e.message; });
      }
      return json({ ok: true });
    }
    if (u.pathname === '/api/state') {
      const existing = chats.get(u.searchParams.get('chat'));
      const t = existing?.turns?.[Number(u.searchParams.get('turn') ?? 0)];
      return json({ done: !!t?.done, reply: t?.reply });
    }
    if (u.pathname === '/' || u.pathname.startsWith('/c/')) {
      state.loads++;
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(PAGE({ mode: state.mode, picker: state.picker, defaultModel: state.defaultModel }));
    }
    res.writeHead(404); res.end();
  });
  await new Promise((r) => srv.listen(port, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${srv.address().port}/`, state, close: () => new Promise((r) => { srv.closeAllConnections?.(); srv.close(r); }) };
}
