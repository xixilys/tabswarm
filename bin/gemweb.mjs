#!/usr/bin/env node
// gemweb — dispatch tasks to Gemini or ChatGPT web and watch what it does through the local MCP server.
// Runs in a dedicated Chrome (own profile, headless), one task at a time per site, at most
// gemweb.daily_limit tasks a day per site; a usage-limit notice on the page stops new tasks to that
// site until it clears.
//
//   gemweb "任务"                       dispatch a task in a new Gemini chat, print Gemini's final report
//   gemweb --site chatgpt "任务"         the same in a new ChatGPT chat (no persona or rules, one question, one answer)
//   gemweb --cwd DIR "任务"              tell Gemini which directory the task is about
//   gemweb -f task.md                   task text from a file
//   gemweb --chat <url> "追问"           continue an existing Gemini chat
//   gemweb --no-wait "任务"              print the task id and return immediately
//   gemweb --from <name> ...            who is dispatching (shown on the status page; default $GEMWEB_FROM or user)
//   gemweb --timeout 1800 ...           seconds to wait for report(final)
//   gemweb --model "<picker label>" ... pick a Gemini model by its visible label (default: config gemweb.model_label)
//   gemweb --no-operator ...            fast path only; report BLOCKED instead of calling the operator model
//   gemweb --browser browsermcp ...     opt-in: use your own everyday Chrome (Browser MCP) instead of the dedicated one
//   gemweb login [gemini|chatgpt]       open the dedicated Chrome as a window to sign in once (= gwmcp login <site>)
//   gemweb browser [status|headless]    dedicated Chrome: show state / switch back to headless after login
//   gemweb limit [clear] [site]         daily counts and usage-limit pauses per site; clear lifts a pause (all sites without a site)
//   gemweb --driver mock ...            offline test: a scripted fake Gemini calls the MCP tools (no browser)
//   gemweb result <task_id> [--wait]    print (or wait for) a task's final report
//   gemweb watch [task_id]              live timeline (all tasks when no id); --args shows full arguments, --compact hides output
//   gemweb replay [task_id] [--date YYYY-MM-DD]   replay the JSONL log
//   gemweb list                         recent tasks
//   gemweb status                       server / tunnel / Gemini connection status
//   gemweb approve <confirm_id> | deny <confirm_id>
//   gemweb goal start --name X --cwd DIR --goal "目标" --done "验收命令或文字标准"   keep pushing until done (see gemweb goal help)
//   gemweb goal list | status X | log X | pause X | resume X | stop X
//
// Exit codes (same spirit as webpro): 0 final report printed, 2 usage, 3 Gemini reported blocked /
// browser blocked (login, connector missing), 4 no report before timeout, 5 server not running.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(HERE, '..', 'src');
const { Renderer, col } = await import(path.join(SRC, 'render.js'));
const STATE = process.env.WEBHUB_STATE_DIR || process.env.GWM_STATE_DIR || path.join(os.homedir(), '.gemini-web-mcp');

function readJson(p, d = {}) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return d; } }
const cfg = { admin_host: '127.0.0.1', admin_port: 8782, ...readJson(path.join(STATE, 'config.json')) };
const secrets = readJson(path.join(STATE, 'secrets.json'));
const API = `http://${cfg.admin_host}:${cfg.admin_port}/api`;

// While driving a task, ride out a server restart (~90 s) instead of exiting and leaking the tab.
let apiRetrySec = 0;
async function api(p, { method = 'GET', body } = {}) {
  let r;
  const until = Date.now() + apiRetrySec * 1000;
  for (;;) {
    try {
      r = await fetch(API + p, { method, headers: { 'content-type': 'application/json', authorization: `Bearer ${secrets.admin_token || ''}` }, body: body ? JSON.stringify(body) : undefined });
      break;
    } catch (e) {
      if (Date.now() < until) { await new Promise((res) => setTimeout(res, 3000)); continue; }
      console.error(`gemweb: MCP server not reachable at ${API} (${e.cause?.code || e.message}). Start it: gwmcp start`);
      process.exit(5);
    }
  }
  const text = await r.text();
  let j; try { j = JSON.parse(text); } catch { j = { raw: text }; }
  if (!r.ok) throw Object.assign(new Error(j.error || text || r.statusText), { status: r.status, body: j });
  return j;
}

async function* sseEvents(url) {
  for (;;) {
    let res;
    try { res = await fetch(url, { headers: { accept: 'text/event-stream' } }); } catch (e) {
      process.stderr.write(col.yellow(`[watch] server unreachable (${e.cause?.code || e.message}); retrying in 3s\n`));
      await new Promise((r) => setTimeout(r, 3000)); continue;
    }
    const dec = new TextDecoder(); let buf = '';
    try {
      for await (const chunk of res.body) {
        buf += dec.decode(chunk, { stream: true });
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, i); buf = buf.slice(i + 2);
          let ev = 'message', data = '';
          for (const line of block.split('\n')) {
            if (line.startsWith('event:')) ev = line.slice(6).trim();
            else if (line.startsWith('data:')) data += line.slice(5).trim();
          }
          if (data) yield { event: ev, data: JSON.parse(data) };
        }
      }
    } catch { /* dropped */ }
    process.stderr.write(col.yellow('[watch] stream ended; reconnecting\n'));
    await new Promise((r) => setTimeout(r, 1500));
    const u = new URL(url); u.searchParams.set('since', String(lastSeq)); u.searchParams.set('backlog', '100000'); url = u.toString();
  }
}
let lastSeq = 0;

async function watch(taskId, opts) {
  const r = new Renderer({ showArgs: opts.args, compact: opts.compact });
  const u = new URL(API + '/stream');
  if (taskId) u.searchParams.set('task_id', taskId);
  u.searchParams.set('backlog', String(opts.backlog ?? (taskId ? 100000 : 300)));
  console.log(col.gray(`watching ${taskId || 'all tasks'} — ${API.replace('/api', '/')} — Ctrl-C to stop`));
  for await (const { event, data } of sseEvents(u.toString())) {
    if (event === 'ready') { console.log(col.gray('──── live ────')); continue; }
    if (data.seq <= lastSeq) continue;
    lastSeq = data.seq;
    r.event(data);
  }
}

function replay(taskId, opts) {
  const dir = path.join(STATE, 'logs');
  let files = fs.readdirSync(dir).filter((f) => /^events-.*\.jsonl$/.test(f)).sort();
  if (opts.date) files = files.filter((f) => f.includes(opts.date));
  const r = new Renderer({ showArgs: opts.args, compact: opts.compact });
  for (const f of files) {
    for (const line of fs.readFileSync(path.join(dir, f), 'utf8').split('\n')) {
      if (!line.trim()) continue;
      let ev; try { ev = JSON.parse(line); } catch { continue; }
      if (taskId && ev.task_id !== taskId) continue;
      r.event(ev);
    }
  }
}

function printFinal(t) {
  const f = t.final;
  if (!f) return;
  if (f.source === 'page') console.log(f.content); // no report call: the model's last reply on the page
  else console.log(f.content ? `${f.summary}\n\n${f.content}` : f.summary);
  const extra = [];
  if (f.source === 'page') extra.push('answer: last reply on the page (the model did not call report)');
  if (f.tests) extra.push(`tests: ${f.tests}`);
  const calls = t.tool_calls ? `${t.tool_calls} tool calls${t.denied_calls ? `, ${t.denied_calls} denied` : ''}` : '';
  if (calls) extra.push(calls);
  if (t.tool_summary?.length) extra.push(`what it did on this computer:\n${t.tool_summary.map((x) => '  ' + x).join('\n')}`);
  if (t.files_changed?.length) extra.push(`files changed:\n${t.files_changed.map((x) => '  ' + x).join('\n')}`);
  if (t.conflicts?.length) extra.push(`conflicts:\n${t.conflicts.map((c) => `  ${c.path}: ${c.message}`).join('\n')}`);
  if (t.chat_url) extra.push(`chat: ${t.chat_url}`);
  if (t.account && t.account !== 'default') extra.push(`account: ${t.account}`);
  extra.push(`task: ${t.id}`);
  console.log('\n---\n' + extra.join('\n'));
}

async function waitFinal(id, timeoutSec, { quiet = false } = {}) {
  const deadline = Date.now() + timeoutSec * 1000;
  let t = await api(`/tasks/${id}`);
  while (!t.final && Date.now() < deadline && !['failed', 'abandoned', 'interrupted', 'cancelled'].includes(t.status)) {
    t = await api(`/tasks/${id}/wait?wait=50&reports=${t.reports.length}`);
    if (!quiet) for (const rep of t.reports.slice(-1)) if (rep.status === 'progress' && rep !== waitFinal._last?.[id]) { process.stderr.write(col.gray(`[progress] ${rep.summary}\n`)); (waitFinal._last ||= {})[id] = rep; }
  }
  return t;
}

// ---------------- argv ----------------
const argv = process.argv.slice(2);
const flags = { args: false, compact: false, wait: true, timeout: null, from: process.env.GEMWEB_FROM || os.userInfo().username, driver: process.env.GEMWEB_DRIVER || undefined };
const pos = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '-f' || a === '--file') flags.file = argv[++i];
  else if (a === '--chat') flags.chat = argv[++i];
  else if (a === '--from') flags.from = argv[++i];
  else if (a === '--timeout') flags.timeout = Number(argv[++i]);
  else if (a === '--title') flags.title = argv[++i];
  else if (a === '--model') flags.model = argv[++i];
  else if (a === '--effort') flags.effort = argv[++i];
  else if (a === '--allow-pro') flags.allowPro = true;
  else if (a === '--dry-run') flags.dryRun = true;
  else if (a === '--date') flags.date = argv[++i];
  else if (a === '--backlog') flags.backlog = Number(argv[++i]);
  else if (a === '--args') flags.args = true;
  else if (a === '--compact') flags.compact = true;
  else if (a === '--no-wait') flags.wait = false;
  else if (a === '--wait') flags.waitResult = true;
  else if (a === '--headed') flags.headed = true;
  else if (a === '--keep-tab') flags.keepTab = true;
  else if (a === '--no-operator') flags.noOperator = true;
  else if (a === '--force') flags.force = true;
  else if (a === '--check') flags.check = true;
  else if (a === '--driver') flags.driver = argv[++i];
  else if (a === '--browser') flags.browser = argv[++i];
  else if (a === '--cwd') flags.cwd = path.resolve(argv[++i]);
  else if (a === '-a' || a === '--account') flags.account = argv[++i];
  else if (a.startsWith('--account=')) flags.account = a.slice(10);
  else if (a === '--site') { flags.site = argv[++i]; if (!['gemini', 'chatgpt'].includes(flags.site)) { console.error('gemweb: --site is gemini or chatgpt'); process.exit(2); } }
  else if (a === '-h' || a === '--help') { const src = fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n'); console.log(src.slice(1, src.findIndex((l) => l.startsWith('import'))).map((l) => l.replace(/^\/\/ ?/, '')).join('\n')); process.exit(0); }
  else pos.push(a);
}

const cmd = pos[0];
try {
  if (cmd === 'watch') await watch(pos[1], flags);
  else if (cmd === 'replay') replay(pos[1], flags);
  else if (cmd === 'list') {
    const ts = await api('/tasks');
    for (const t of ts.slice(0, 30)) console.log(`${t.id.padEnd(14)} ${t.status.padEnd(12)} ${String(t.tool_calls).padStart(3)} calls  ${(t.from || '').padEnd(12)} ${t.title}`);
  } else if (cmd === 'status') {
    const s = await api('/state');
    const c = [...s.clients].sort((a, b) => a.idle_sec - b.idle_sec)[0];
    console.log(`server   v${s.server.version} pid ${s.server.pid} since ${s.server.started}`);
    console.log(`status   http://${cfg.admin_host}:${cfg.admin_port}/`);
    console.log(`tunnel   ${s.tunnel.mcp_url || col.red('down')}`);
    console.log(`gemini   ${c ? `${c.name} last seen ${c.idle_sec}s ago (${c.requests} requests)` : 'never connected'}`);
    console.log(`oauth    ${s.oauth_clients.filter((x) => !x.manual).length} registered clients, ${s.oauth_clients.reduce((n, x) => n + x.live_tokens, 0)} live tokens`);
    console.log(`browser  ${s.web?.browser === 'browsermcp' ? 'your own Chrome (Browser MCP)' : `dedicated Chrome ${cfg.gemweb?.cdp_url || 'http://127.0.0.1:9230'}`}${s.web?.owner_chrome_fallback ? ' (falls back to your own Chrome)' : ''}; ${s.slots.running.length}/${s.slots.limit} running, ${s.slots.queued.length} queued, ${s.slots.min_interval_sec ?? 0}s between starts`);
    if (s.web) for (const [name, w] of Object.entries(s.web.sites || { gemini: s.web })) console.log(`${(name === 'gemini' ? 'today' : '').padEnd(8)} ${name} ${w.used_today}/${s.web.daily_limit || '∞'} tasks sent${w.limit ? col.red(`; PAUSED by a usage-limit notice until ${w.limit.until}: ${w.limit.notice}`) : ''}`);
    if ((s.accounts || []).length > 1) {
      for (const a of s.accounts) {
        const parts = Object.entries(a.quota || {}).filter(([, q]) => q.supported).map(([sn, q]) => `${sn} ${q.used_today}/${q.daily_limit || '∞'}${q.limit ? ' PAUSED' : ''}`);
        console.log(`account  ${a.name.padEnd(12)} ${a.cdp_url}  ${parts.join(' · ')}`);
      }
    }
    console.log(`pending  ${s.pending.length} approvals${s.pending.map((p) => `\n  ${p.id}  ${p.command}`).join('')}`);
    console.log(`roots    ${s.server.roots.map((r) => r.path).join(', ')}`);
  } else if (cmd === 'limit') {
    if (pos[1] === 'clear') { const r = await api('/web-limit/clear', { method: 'POST', body: { site: pos[2] || flags.site, account: flags.account || null } }); console.log(r.ok ? 'usage-limit pause cleared' : 'no usage-limit pause was set'); }
    else {
      const s = await api('/state');
      for (const [name, w] of Object.entries(s.web.sites || { gemini: s.web })) {
        console.log(`${name}: today ${w.used_today}/${s.web.daily_limit || '∞'} tasks sent; ${w.limit ? `paused until ${w.limit.until} (seen ${w.limit.at}${w.limit.task_id ? ` in ${w.limit.task_id}` : ''}): ${w.limit.notice}` : 'no usage-limit pause'}`);
      }
    }
  } else if (cmd === 'login' || cmd === 'browser') {
    const { loginCli } = await import(path.join(SRC, 'login.js'));
    const fwd = cmd === 'login' ? ['login', ...pos.slice(1)] : pos.slice(1);
    if (flags.force) fwd.push('--force');
    if (flags.check) fwd.push('--check');
    if (flags.account) fwd.push('--account', flags.account);
    process.exit(await loginCli(fwd, { cfg: (await import(path.join(SRC, 'config.js'))).loadConfig(), api, account: flags.account || null }));
  } else if (cmd === 'approve' || cmd === 'deny') {
    if (!pos[1]) { console.error('usage: gemweb approve|deny <confirm_id>'); process.exit(2); }
    const r = await api(`/confirm/${pos[1]}`, { method: 'POST', body: { approve: cmd === 'approve' } });
    console.log(r.ok ? `${cmd}d ${pos[1]}` : `no pending approval ${pos[1]}`);
  } else if (cmd === 'goal') {
    const { goalCli } = await import(path.join(SRC, 'goals.js'));
    process.exit(await goalCli(pos.slice(1), { argv, api, cfg: (await import(path.join(SRC, 'config.js'))).loadConfig(), gemwebPath: fileURLToPath(import.meta.url) }));
  } else if (cmd === '__drive') {
    // background half of --no-wait
    apiRetrySec = 90;
    const t = await api(`/tasks/${pos[1]}`);
    const { drive } = await import(path.join(SRC, 'driver.js'));
    process.exit(await drive({ id: t.id, task: t.prompt, cwd: t.cwd || null, site: t.site || flags.site || 'gemini', account: t.account || flags.account || null, flags, api, waitFinal, printFinal, cfg: { ...(await import(path.join(SRC, 'config.js'))).loadConfig() }, timeoutSec: flags.timeout || 1800 }));
  } else if (cmd === 'result') {
    if (!pos[1]) { console.error('usage: gemweb result <task_id> [--wait]'); process.exit(2); }
    const t = flags.waitResult ? await waitFinal(pos[1], flags.timeout || 1800) : await api(`/tasks/${pos[1]}`);
    if (!t.final) { console.error(`gemweb: no final report yet (status ${t.status})`); process.exit(4); }
    t.tool_summary = await (await import(path.join(SRC, 'driver.js'))).toolSummary(api, t.id);
    printFinal(t); process.exit(t.final.status === 'final' ? 0 : 3);
  } else {
    // dispatch
    let task = flags.file ? fs.readFileSync(flags.file, 'utf8') : pos.join(' ');
    if (!task.trim()) { console.error('gemweb: empty task (see gemweb --help)'); process.exit(2); }
    apiRetrySec = 90;
    const { dispatch } = await import(path.join(SRC, 'driver.js'));
    const fullCfg = (await import(path.join(SRC, 'config.js'))).loadConfig();
    const code = await dispatch({ task, flags, api, waitFinal, printFinal, cfg: fullCfg, secrets });
    process.exit(code);
  }
} catch (e) {
  console.error(`gemweb: ${e.message}`);
  process.exit(e.status === 404 ? 2 : 1);
}
