// Fake Gemini web page for offline tests of the dedicated-Chrome driver. It has the parts gemweb
// uses (prompt box, Chat|Task toggle, "@" app menu, mode picker with models and a "Thinking level"
// submenu, Send/Stop, a tool prompt with
// Don't allow / Allow once / Always allow, model-response) and, once the tool prompt is answered,
// acts as Gemini by running the MOCK lines of the task against the MCP server (src/mock-gemini.js).
//   mode: 'ok' | 'limit' (usage-limit notice after send) | 'signedout'
import http from 'node:http';
import crypto from 'node:crypto';

const PAGE = (mode) => `<!doctype html><html><head><meta charset="utf-8"><title>Google Gemini</title><style>[role=menu] span{display:block}</style></head><body>
<main><div id="chat"></div>
${mode === 'signedout' ? '<button id="signin">Sign in</button>' : ''}
<div id="composer">
  <div id="ed" contenteditable="true" role="textbox" aria-label="Enter a prompt here" style="min-height:40px;border:1px solid #888"></div>
  <div id="menu" role="menu" style="display:none"><div role="menuitem" id="app">Local Projects</div></div>
  <button id="modebtn" data-test-id="bard-mode-menu-button"></button>
  <div id="modemenu" role="menu" style="display:none">
    <div role="menuitemradio" data-m="Auto"><span>Auto</span><span>Adapts to your needs</span></div>
    <div role="menuitemradio" data-m="Hydrogen"><span>Everyday help</span><span>4 Hydrogen</span></div>
    <div role="menuitemradio" data-m="Neon"><span>Deeper analysis</span><span>4 Neon</span></div>
    <div role="menuitemradio" data-m="Carbon"><span>Code &amp; complex work</span><span>4 Carbon</span></div>
    <div role="menuitem" aria-haspopup="true" id="thinkitem"><span>Thinking level</span></div>
  </div>
  <div id="thinkmenu" role="menu" style="display:none">
    <div role="menuitemradio" data-t="Low"><span>Low</span><span>Fast and efficient</span></div>
    <div role="menuitemradio" data-t="Medium"><span>Medium</span><span>Balanced depth</span></div>
    <div role="menuitemradio" data-t="High"><span>High</span><span>Extra thorough</span></div>
  </div>
  <button id="chatmode" aria-pressed="true">Chat</button><button id="task" aria-pressed="false">Task</button>
  <button id="send" aria-label="Send message">Send</button>
  <button id="stop" aria-label="Stop response" style="display:none">Stop</button>
</div></main>
<script>
const $ = (id) => document.getElementById(id);
let mention = false;
$('ed').addEventListener('input', () => { $('menu').style.display = /@\\w*$/.test($('ed').innerText) ? 'block' : 'none'; });
$('app').addEventListener('mousedown', (e) => e.preventDefault()); // keeps focus in the prompt box, like Gemini
$('app').addEventListener('click', () => {
  $('ed').innerText = $('ed').innerText.replace(/@\\w*$/, '@Local Projects');
  mention = true; $('menu').style.display = 'none';
  const r = document.createRange(); r.selectNodeContents($('ed')); r.collapse(false); const s = getSelection(); s.removeAllRanges(); s.addRange(r);
});
$('task').addEventListener('click', () => { $('task').setAttribute('aria-pressed', 'true'); $('chatmode').setAttribute('aria-pressed', 'false'); });
// mode picker: the choice persists like the account setting. Like the live page, after a
// thinking-level change the button shows "<model> <level>", and a model switch after that
// leaves the button ignoring clicks until a reload.
let mode = { model: localStorage.getItem('fg-model') || 'Carbon', think: localStorage.getItem('fg-think') || 'Low' };
let stuck = false, thinkChanged = false, label = mode.model;
const paint = () => {
  $('modebtn').innerText = label; $('modebtn').setAttribute('aria-label', 'Open mode picker, currently ' + label);
  for (const r of $('modemenu').querySelectorAll('[data-m]')) r.setAttribute('aria-checked', String(r.dataset.m === mode.model));
  for (const r of $('thinkmenu').querySelectorAll('[data-t]')) r.setAttribute('aria-checked', String(r.dataset.t === mode.think));
};
const closeMenus = () => { $('modemenu').style.display = 'none'; $('thinkmenu').style.display = 'none'; };
paint();
$('modebtn').addEventListener('click', () => { if (stuck) return; $('modemenu').style.display = $('modemenu').style.display === 'none' ? 'block' : 'none'; $('thinkmenu').style.display = 'none'; });
$('thinkitem').addEventListener('mouseenter', () => { $('thinkmenu').style.display = 'block'; });
for (const r of $('modemenu').querySelectorAll('[data-m]')) r.addEventListener('click', () => {
  mode.model = r.dataset.m; localStorage.setItem('fg-model', mode.model); if (thinkChanged) stuck = true; label = thinkChanged ? mode.model + ' ' + mode.think : mode.model; closeMenus(); paint();
});
for (const r of $('thinkmenu').querySelectorAll('[data-t]')) r.addEventListener('click', () => {
  mode.think = r.dataset.t; localStorage.setItem('fg-think', mode.think); thinkChanged = true; label = mode.model + ' ' + mode.think; closeMenus(); paint();
});
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeMenus(); });
function add(tag, html) { const d = document.createElement(tag); d.innerHTML = html; $('chat').appendChild(d); return d; }
async function send() {
  const text = $('ed').innerText;
  const r = await fetch('/api/send', { method: 'POST', body: JSON.stringify({ text, mention, task: $('task').getAttribute('aria-pressed') === 'true', model: mode.model, think: mode.think }) }).then((x) => x.json());
  history.pushState({}, '', '/app/' + r.chat);
  $('ed').innerText = '';
  add('div', 'You said ' + text.slice(0, 40).replace(/</g, '&lt;'));
  $('stop').style.display = '';
  if (r.limit) { $('stop').style.display = 'none'; add('div', '<div role="alert">You\\'ve reached your limit for Gemini. Try again later.</div>'); return; }
  const p = add('div', 'Let Gemini use write_file? <button class="c">Don\\'t allow</button><button class="c">Allow once</button><button class="c">Always allow</button>');
  for (const b of p.querySelectorAll('button')) b.addEventListener('click', async () => {
    p.querySelectorAll('button').forEach((x) => { x.disabled = true; });
    await fetch('/api/confirm', { method: 'POST', body: JSON.stringify({ chat: r.chat, answer: b.innerText }) });
    const poll = setInterval(async () => { const s = await fetch('/api/state?chat=' + r.chat).then((x) => x.json()); if (s.done) { clearInterval(poll); $('stop').style.display = 'none'; add('model-response', 'Done: ' + s.summary); } }, 500);
  });
}
$('send').addEventListener('click', send);
</script></body></html>`;

export async function startFakeGemini({ port = 0, mode = 'ok', runMock }) {
  const chats = new Map();
  const state = { mode, sends: [], confirms: [] };
  const srv = http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://x');
    const body = req.method === 'POST' ? JSON.parse(await new Promise((r) => { let b = ''; req.on('data', (c) => { b += c; }); req.on('end', () => r(b || '{}')); })) : {};
    const json = (o) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
    if (u.pathname === '/api/send') {
      const chat = crypto.randomBytes(8).toString('hex');
      const id = /TASK_ID:\s*(\S+)/.exec(body.text)?.[1] || null;
      chats.set(chat, { id, text: body.text, done: false });
      state.sends.push({ chat, id, mention: body.mention, task_mode: body.task, text: body.text, model: body.model, think: body.think });
      return json({ chat, limit: state.mode === 'limit' });
    }
    if (u.pathname === '/api/confirm') {
      const c = chats.get(body.chat); state.confirms.push(body.answer);
      if (c && body.answer !== "Don't allow" && !c.started) {
        c.started = true;
        runMock({ id: c.id, task: c.text }).then(() => { c.done = true; c.summary = 'mock finished'; }, (e) => { c.done = true; c.summary = 'mock failed: ' + e.message; });
      }
      return json({ ok: true });
    }
    if (u.pathname === '/api/state') { const c = chats.get(u.searchParams.get('chat')); return json({ done: !!c?.done, summary: c?.summary }); }
    if (u.pathname === '/app' || u.pathname.startsWith('/app/')) { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); return res.end(PAGE(state.mode)); }
    res.writeHead(404); res.end();
  });
  await new Promise((r) => srv.listen(port, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${srv.address().port}/app?hl=en`, state, close: () => new Promise((r) => { srv.closeAllConnections?.(); srv.close(r); }) };
}
