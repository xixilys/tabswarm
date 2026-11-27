#!/usr/bin/env node
// Tests for `gemweb --site chatgpt` in an isolated headless Chrome against a fake ChatGPT page
// (scripts/fixtures/fake-chatgpt.mjs): new chat and `--chat` continuation, Pro model guard &
// `--model`/`--allow-pro`/`--dry-run` verification, answer from report or last page reply, tool-call
// summary, tab cleanup, per-site daily cap, usage-limit pause, and slots.
// Own server (temp state dir, ports 18781/18782, isolated Chrome CDP 19231).   node scripts/chatgpt-test.mjs [--keep]
import './fixtures/fake-clock.mjs'; // pinned local day: a run crossing midnight cannot change "today" mid-test
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { reap, assertPortsFree } from './fixtures/reap.mjs';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(HERE, '..');
const GEMWEB = path.join(REPO, 'bin', 'gemweb.mjs');
const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gwm-ctest-')));
const ROOT = path.join(TMP, 'root'); fs.mkdirSync(ROOT);
process.env.WEBHUB_STATE_DIR = path.join(TMP, 'state');
process.env.GWM_STATE_DIR = process.env.WEBHUB_STATE_DIR;
const PUB = 18781, ADM = 18782, CDP_PORT = 19231, CDP = `http://127.0.0.1:${CDP_PORT}`;

let pass = 0, fail = 0;
const check = (name, ok, detail = '') => { if (ok) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${name}`); } else { fail++; console.log(`  \x1b[31m✗ ${name}\x1b[0m ${String(detail).slice(0, 700)}`); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const { startFakeChatgpt } = await import('./fixtures/fake-chatgpt.mjs');
let cfgRef = null;
const fake = await startFakeChatgpt({ runMock: async ({ id, task }) => { const { mockGemini } = await import('../src/mock-gemini.js'); return mockGemini({ id, task, cfg: cfgRef }); } });
fs.mkdirSync(process.env.GWM_STATE_DIR, { recursive: true });
fs.writeFileSync(path.join(process.env.GWM_STATE_DIR, 'config.json'), JSON.stringify({
  public_port: PUB, admin_port: ADM, roots: [{ name: 'ctest', path: ROOT }],
  gemweb: { concurrency: 1, min_interval_sec: 2, daily_limit: 4, limit_cooldown_min: 5, operator_models: [], cdp_url: CDP, headless: true, browser_mode: 'chrome', profile_dir: path.join(TMP, 'chrome-profile'), chatgpt: { url: fake.url, idle_sec: 3 } },
}));
const { loadConfig } = await import('../src/config.js');
cfgRef = loadConfig();

// ---------------- unit ----------------
console.log('prompt (no persona, no rules):');
const { composePrompt } = await import('../src/driver.js');
const { siteFor } = await import('../src/sites.js');
const p = composePrompt('t_abc', '把 README 的错别字改掉', cfgRef, siteFor('chatgpt'), null);
check('prompt = the task + one sentence about task_id / report', p === `把 README 的错别字改掉\n\nPass task_id="t_abc" on every Local Projects tool call, and when you are done call report(task_id="t_abc", status="final", summary, content=<your answer>).`, p);
check('with --cwd: one "Working directory" line before the task', composePrompt('t_abc', 'x', cfgRef, siteFor('chatgpt'), '/r').startsWith('Working directory: /r\n\nx\n\n'));

console.log('per-site limits:');
const { usedToday, dispatchRefusal, recordLimit, clearLimit } = await import('../src/quota.js');
const now = new Date();
const mk = (site) => ({ origin: 'gemweb', created: now.toISOString(), status: 'done', sent_at: now.toISOString(), ...(site ? { site } : {}) });
const sample = [mk(), mk('gemini'), mk('chatgpt'), mk('chatgpt'), mk('chatgpt'), mk('chatgpt')];
check('daily count per site (tasks without a site are Gemini)', usedToday(sample, now, 'gemini') === 2 && usedToday(sample, now, 'chatgpt') === 4);
check('daily cap reached on ChatGPT does not stop Gemini', dispatchRefusal(cfgRef, sample, { site: 'chatgpt' })?.kind === 'daily-cap' && dispatchRefusal(cfgRef, sample, { site: 'gemini' }) === null);
recordLimit({ notice: 'limit', cooldownMin: 5, site: 'chatgpt' });
check('ChatGPT usage-limit pause does not stop Gemini', dispatchRefusal(cfgRef, [], { site: 'chatgpt' })?.kind === 'rate-limit' && dispatchRefusal(cfgRef, [], { site: 'gemini' }) === null);
clearLimit('chatgpt');
check('clear lifts it', dispatchRefusal(cfgRef, [], { site: 'chatgpt' }) === null);
const { Slots } = await import('../src/slots.js');
const recs = new Map([['g1', { id: 'g1', site: 'gemini' }], ['c1', { id: 'c1', site: 'chatgpt' }], ['c2', { id: 'c2', site: 'chatgpt' }]]);
const sl = new Slots({ gemweb: { concurrency: 1, min_interval_sec: 60 } }, { get: (id) => recs.get(id), isActive: () => true, setStatus() {} }, { emit() {} });
const g1 = await sl.acquire(recs.get('g1'), 0);
const c1 = await sl.acquire(recs.get('c1'), 0);
const c2 = await sl.acquire(recs.get('c2'), 200);
check('one at a time per site: a ChatGPT task starts while a Gemini task runs, a 2nd ChatGPT task waits', g1.granted && c1.granted && !c2.granted, JSON.stringify([g1, c1, c2]));
sl.release('g1'); sl.release('c1'); sl.release('c2');

// ---------------- end to end ----------------
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
await assertPortsFree([PUB, ADM, CDP_PORT], 'chatgpt-test');
const chromeProc = reap(spawn(CHROME, [
  `--remote-debugging-port=${CDP_PORT}`,
  `--user-data-dir=${path.join(TMP, 'chrome-profile')}`,
  '--use-mock-keychain', '--password-store=basic',
  '--no-first-run', '--no-default-browser-check', '--headless=new', 'about:blank',
], { stdio: 'ignore' }));
for (let i = 0; i < 60; i++) { if (await fetch(`${CDP}/json/version`).then((r) => r.ok).catch(() => false)) break; await sleep(200); }
const server = reap(spawn(process.execPath, [path.join(REPO, 'src', 'server.js')], { env: { ...process.env }, stdio: ['ignore', 'pipe', 'pipe'] }));
let serverLog = ''; server.stdout.on('data', (d) => { serverLog += d; }); server.stderr.on('data', (d) => { serverLog += d; });
for (let i = 0; i < 50; i++) { if (await fetch(`http://127.0.0.1:${ADM}/api/state`).then((r) => r.ok).catch(() => false)) break; await sleep(200); }
const api = (pth, o = {}) => fetch(`http://127.0.0.1:${ADM}/api${pth}`, { method: o.method || 'GET', headers: { 'content-type': 'application/json', authorization: `Bearer ${JSON.parse(fs.readFileSync(path.join(process.env.GWM_STATE_DIR, 'secrets.json'), 'utf8')).admin_token}` }, body: o.body ? JSON.stringify(o.body) : undefined }).then((r) => r.json());
const gemweb = (args) => new Promise((resolve) => {
  const ch = spawn(process.execPath, [GEMWEB, ...args], { env: { ...process.env, GEMWEB_FROM: 'ctest' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '', err = ''; ch.stdout.on('data', (d) => { out += d; }); ch.stderr.on('data', (d) => { err += d; });
  ch.on('close', (code) => resolve({ code, out, err, id: /TASK_ID=(\S+)/.exec(err)?.[1] }));
});
const fakePages = async () => (await fetch(`${CDP}/json/list`).then((r) => r.json()).catch(() => [])).filter((t) => t.type === 'page' && t.url.startsWith(fake.url));
const task = (name, extra = '') => `Write ${name}.\nMOCK write ${ROOT}/${name}\nhello from ${name}\nMOCK end\nMOCK run ${ROOT} :: cat ${name}${extra}`;

console.log('Pro model guard, --model verification & --dry-run (isolated headless Chrome):');
fake.state.picker = true;
fake.state.defaultModel = 'GPT-6.2 Pro';
let r = await gemweb(['--site', 'chatgpt', '--timeout', '60', 'hello']);
check('Pro active without --model/--allow-pro -> BLOCKED: model-guard (exit 3), no send', r.code === 3 && /BLOCKED: model-guard\|/.test(r.out) && fake.state.sends.length === 0, `${r.code} ${r.out} ${r.err}`);
r = await gemweb(['--site', 'chatgpt', '--model', 'Nonexistent Model', '--timeout', '60', 'hello']);
check('unknown --model -> BLOCKED: model-unavailable (exit 3), no send', r.code === 3 && /BLOCKED: model-unavailable\|/.test(r.out) && fake.state.sends.length === 0, `${r.code} ${r.out} ${r.err}`);
r = await gemweb(['--site', 'chatgpt', '--dry-run', '--model', 'GPT-6.2 Thinking', '--timeout', '60', 'hello']);
check('--dry-run verifies model & connector without sending (exit 0)', r.code === 0 && /DRY-RUN-OK.*GPT-6\.2 Thinking/.test(r.out) && fake.state.sends.length === 0, `${r.code} ${r.out} ${r.err}`);
r = await gemweb(['--site', 'chatgpt', '--dry-run', '--model', 'Extra High', '--timeout', '60', 'hello']);
check('--model "Extra High" is set on the reasoning-level slider (dry-run)', r.code === 0 && /DRY-RUN-OK.*Extra High/.test(r.out) && fake.state.sends.length === 0, `${r.code} ${r.out} ${r.err}`);
r = await gemweb(['--site', 'chatgpt', '--dry-run', '--model', 'Pro', '--timeout', '60', 'hello']);
check('a Pro reasoning level is refused without --allow-pro (model-guard)', r.code === 3 && /BLOCKED: model-guard\|/.test(r.out), `${r.code} ${r.out} ${r.err}`);
check('no tab left after dry-run / guard', (await fakePages()).length === 0);

console.log('task with report (--allow-pro overrides Pro guard):');
r = await gemweb(['--site', 'chatgpt', '--allow-pro', '--timeout', '120', task('one.txt')]);
check('finishes with the report (exit 0)', r.code === 0 && /mock run for .* finished/.test(r.out), `code ${r.code}\n${r.out}\n${r.err}`);
let t = r.id ? await api(`/tasks/${r.id}`) : {};
const firstChatUrl = t.chat_url;
check('task recorded as site chatgpt, dedicated Chrome, verified Pro model', t.site === 'chatgpt' && t.driver?.browser === 'cdp' && t.driver?.site === 'chatgpt' && t.driver?.model === 'GPT-6.2 Pro', JSON.stringify({ site: t.site, driver: t.driver }));
const s1 = fake.state.sends[0] || {};
check('custom MCP server picked with "@"', s1.mention === true && s1.model === 'GPT-6.2 Pro', JSON.stringify(s1).slice(0, 200));
check('sent text = task + the one report sentence (no TASK_ID card, no rules)', s1.text?.trim().startsWith('Write one.txt.') && /Pass task_id="t_[^"]+" on every Local Projects tool call/.test(s1.text) && !/TASK_ID:|^RULES|^You are |persona/m.test(s1.text) && s1.text.trim().split("\n\n").length === 2, s1.text);
check('tool call confirmed, "Remember" ticked first', fake.state.confirms[0]?.answer === 'Confirm' && fake.state.confirms[0]?.remember === true, JSON.stringify(fake.state.confirms));
check('file written through MCP', fs.readFileSync(path.join(ROOT, 'one.txt'), 'utf8') === 'hello from one.txt\n');
check('result lists what it did on this computer', /what it did on this computer:\n\s+list_roots[\s\S]*write_file[\s\S]*run_command/.test(r.out), r.out);
check('chat URL recorded (/c/<id>)', /\/c\/[0-9a-f]{16}$/.test(firstChatUrl || ''), firstChatUrl);
check('task tab closed', (await fakePages()).length === 0, JSON.stringify(await fakePages()));

console.log('task without report (--model switches off Pro; page reply is the answer):');
const loads = fake.state.loads;
r = await gemweb(['--site', 'chatgpt', '--model', 'GPT-6.2 Thinking', '--timeout', '120', task('two.txt', '\nMOCK noreport')]);
check('finishes (exit 0) with the last page reply', r.code === 0 && /I wrote the file and ran the check/.test(r.out) && /last reply on the page/.test(r.out), `code ${r.code}\n${r.out}\n${r.err}`);
check('tool summary attached', /what it did on this computer:[\s\S]*write_file/.test(r.out), r.out);
t = r.id ? await api(`/tasks/${r.id}`) : {};
check('report stored with source page and switched model', t.final?.source === 'page' && t.status === 'done' && t.driver?.model === 'GPT-6.2 Thinking' && fake.state.sends[1]?.model === 'GPT-6.2 Thinking', JSON.stringify({ final: t.final, driver: t.driver, send: fake.state.sends[1]?.model }));
check('a new chat: page loaded fresh, different chat id', fake.state.loads > loads && fake.state.sends[1]?.chat !== s1.chat);
r = await gemweb(['result', t.id || 'x']);
check('gemweb result prints it with the tool summary', r.code === 0 && /I wrote the file/.test(r.out) && /what it did on this computer/.test(r.out), r.out + r.err);

console.log('blocked cases:');
fake.state.defaultModel = 'GPT-6.2 Thinking';
fake.state.mode = 'signedout';
r = await gemweb(['--site', 'chatgpt', '--timeout', '60', 'hello']);
check('not signed in -> BLOCKED: auth with webhub login chatgpt (exit 3)', r.code === 3 && /BLOCKED: auth\|.*webhub login chatgpt/.test(r.out), `${r.code} ${r.out} ${r.err}`);
fake.state.mode = 'noconnector';
r = await gemweb(['--site', 'chatgpt', '--timeout', '60', 'hello']);
check('server not added in ChatGPT -> BLOCKED: connector-missing (exit 3)', r.code === 3 && /BLOCKED: connector-missing\|.*README/.test(r.out), `${r.code} ${r.out} ${r.err}`);
check('no tab left', (await fakePages()).length === 0);

console.log('usage limit stops ChatGPT only:');
fake.state.mode = 'limit';
r = await gemweb(['--site', 'chatgpt', '--timeout', '60', 'hello']);
check('BLOCKED: rate-limit with the notice (exit 3)', r.code === 3 && /BLOCKED: rate-limit\|.*usage limit/.test(r.out), `${r.code} ${r.out} ${r.err}`);
fake.state.mode = 'ok';
r = await gemweb(['--site', 'chatgpt', '--timeout', '60', 'hello']);
check('next ChatGPT task refused before opening the browser', r.code === 3 && /BLOCKED: rate-limit\|ChatGPT .*paused until/.test(r.out) && !r.id, `${r.code} ${r.out}`);
r = await gemweb(['limit']);
check('gemweb limit: ChatGPT paused, Gemini not', /chatgpt: .*paused until/.test(r.out) && /gemini: .*no usage-limit pause/.test(r.out), r.out);
r = await gemweb(['status']);
check('gemweb status shows both sites', /gemini 0\/4 tasks sent/.test(r.out) && /chatgpt \d\/4 tasks sent; PAUSED/.test(r.out), r.out);
r = await gemweb(['limit', 'clear', 'chatgpt']);
check('gemweb limit clear chatgpt', /cleared/.test(r.out), r.out);

console.log('--chat continuation in existing ChatGPT conversation:');
r = await gemweb(['--site', 'chatgpt', '--chat', firstChatUrl, '--model', 'GPT-6.2 Instant', '--timeout', '120', task('three.txt')]);
const s3 = fake.state.sends.at(-1) || {};
check('--chat follows up in same /c/<id> (turn 1) with requested model', r.code === 0 && s3.chat === s1.chat && s3.turn === 1 && s3.model === 'GPT-6.2 Instant' && fs.readFileSync(path.join(ROOT, 'three.txt'), 'utf8') === 'hello from three.txt\n', JSON.stringify({ code: r.code, s3, out: r.out.slice(0, 200) }));

console.log('daily cap (4 per site in this test):');
r = await gemweb(['--site', 'chatgpt', '--timeout', '60', 'hello']);
check('5th ChatGPT task of the day refused: BLOCKED: daily-cap', r.code === 3 && /BLOCKED: daily-cap\|.*ChatGPT today/.test(r.out), `${r.code} ${r.out} ${r.err}`);
const evs = await fetch(`http://127.0.0.1:${ADM}/api/events?limit=5000`).then((x) => x.json());
check('page-reply answer and refusals on the timeline', evs.some((e) => e.type === 'report' && e.source === 'page') && evs.some((e) => e.type === 'task.refused' && e.site === 'chatgpt'));

const exited = (p) => new Promise((r) => { if (p.exitCode !== null || p.signalCode) return r(); p.once('exit', r); setTimeout(r, 5000); });
server.kill('SIGTERM'); chromeProc.kill('SIGTERM'); await fake.close();
await Promise.all([exited(server), exited(chromeProc)]);
if (!process.argv.includes('--keep')) fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 6, retryDelay: 200 }); else console.log(`kept ${TMP}`);
if (fail) console.log(serverLog.split('\n').slice(-15).join('\n'));
console.log(`\n${fail ? '\x1b[31m' : '\x1b[32m'}${pass} passed, ${fail} failed\x1b[0m`);
process.exit(fail ? 1 : 0);
