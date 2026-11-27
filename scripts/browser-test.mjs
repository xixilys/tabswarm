#!/usr/bin/env node
// Tests for the dedicated-Chrome path, tab cleanup, the daily cap and the usage-limit stop.
// Runs its own server (temp state dir, ports 18781/18782) and a fake Gemini page; drives the real
// dedicated Chrome (dsh-browser, CDP 127.0.0.1:9229). Touches neither the installed service nor
// the owner's Chrome.   node scripts/browser-test.mjs [--keep]
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
const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gwm-btest-')));
const ROOT = path.join(TMP, 'root'); fs.mkdirSync(ROOT);
process.env.GWM_STATE_DIR = path.join(TMP, 'state');
const PUB = 18781, ADM = 18782, CDP_PORT = 19230, CDP = `http://127.0.0.1:${CDP_PORT}`;

let pass = 0, fail = 0;
const check = (name, ok, detail = '') => { if (ok) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${name}`); } else { fail++; console.log(`  \x1b[31m✗ ${name}\x1b[0m ${String(detail).slice(0, 600)}`); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const { startFakeGemini } = await import('./fixtures/fake-gemini.mjs');
let cfgRef = null;
const fake = await startFakeGemini({ runMock: async ({ id, task }) => { const { mockGemini } = await import('../src/mock-gemini.js'); await mockGemini({ id, task, cfg: cfgRef }); } });
fs.mkdirSync(process.env.GWM_STATE_DIR, { recursive: true });
fs.writeFileSync(path.join(process.env.GWM_STATE_DIR, 'config.json'), JSON.stringify({
  public_port: PUB, admin_port: ADM, roots: [{ name: 'btest', path: ROOT }],
  gemweb: { gemini_url: fake.url, concurrency: 1, min_interval_sec: 3, daily_limit: 5, limit_cooldown_min: 5, operator_models: [], cdp_url: CDP, headless: true, browser_mode: 'chrome', profile_dir: path.join(TMP, 'chrome-profile') },
}));
const { loadConfig } = await import('../src/config.js');
cfgRef = loadConfig();

// ---------------- unit ----------------
console.log('browser choice:');
const { browserOrder } = await import('../src/driver.js');
check('default = dedicated Chrome only (never the owner\'s Chrome)', JSON.stringify(browserOrder({}, cfgRef)) === '["cdp"]', browserOrder({}, cfgRef));
check('owner\'s Chrome only when asked: --browser browsermcp', browserOrder({ browser: 'browsermcp' }, cfgRef)[0] === 'browsermcp');
check('owner_chrome_fallback: true -> dedicated first, owner\'s Chrome second', JSON.stringify(browserOrder({}, { gemweb: { ...cfgRef.gemweb, owner_chrome_fallback: true } })) === '["cdp","browsermcp"]');
const { DEFAULT_CONFIG } = await import('../src/config.js');
check('defaults: browser cdp, visible window, 3 at a time, 10 s apart, 30/day', DEFAULT_CONFIG.gemweb.browser === 'cdp' && DEFAULT_CONFIG.gemweb.headless === false && DEFAULT_CONFIG.gemweb.concurrency === 3 && DEFAULT_CONFIG.gemweb.min_interval_sec === 10 && DEFAULT_CONFIG.gemweb.daily_limit === 30);

console.log('usage-limit notices:');
const { limitNotice } = await import('../src/sites.js');
for (const t of ["You've reached your limit for Gemini. Try again later.", "You've hit your usage limit. Upgrade for more.", 'You have reached the current usage cap for GPT-5.', 'Too many requests in 1 hour. Try again later.', '你已达到今日使用上限'])
  check(`detects: ${t.slice(0, 50)}`, !!limitNotice([t]));
check('ignores the task card (TASK_ID) even if it talks about limits', !limitNotice(["TASK_ID: t_1\nYou've reached your limit is the error text to handle"]));
check('ignores long replies', !limitNotice(['x'.repeat(800) + " you've reached your limit"]));
check('ignores ordinary replies', !limitNotice(['Done: wrote rate_limit.py with a token bucket']));

console.log('headless user agent:');
const { normalUserAgent, uaMetadata } = await import('../src/browser.js');
const hua = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/157.0.0.0 Safari/537.36';
check('HeadlessChrome -> Chrome', normalUserAgent(hua).includes(' Chrome/157') && !normalUserAgent(hua).includes('Headless'));
check('client hints carry no Headless brand', !JSON.stringify(uaMetadata(normalUserAgent(hua))).includes('Headless'));

console.log('slots (one at a time, gap between starts):');
const { Slots } = await import('../src/slots.js');
const ev = { emit() {} };
const tstore = { get: () => null, isActive: () => true, setStatus() {} };
const sl = new Slots({ gemweb: { concurrency: 1, min_interval_sec: 2 } }, tstore, ev);
const a1 = await sl.acquire({ id: 'a1' }, 0);
const a2 = await sl.acquire({ id: 'a2' }, 300);
check('second task waits while the first runs', a1.granted && !a2.granted);
sl.release('a1');
const a3 = await sl.acquire({ id: 'a2' }, 300);
check('after release it still waits for the gap', !a3.granted && a3.wait_sec >= 1, JSON.stringify(a3));
const a4 = await sl.acquire({ id: 'a2' }, 3000);
check('then starts', a4.granted);
sl.release('a2');
check('mock-driver tasks skip the gap', (await sl.acquire({ id: 'm1', mock: true }, 0)).granted);
sl.release('m1');

console.log('daily count:');
const { usedToday, localDay } = await import('../src/quota.js');
const now = new Date();
const mk = (o) => ({ origin: 'gemweb', created: now.toISOString(), status: 'done', ...o });
check('counts sent web tasks of today only', usedToday([mk({ sent_at: now.toISOString() }), mk({ sent_at: '2000-01-01T00:00:00Z' }), mk({ sent_at: now.toISOString(), mock: true }), mk({ status: 'blocked' }), mk({ status: 'starting' }), { origin: 'mcp', created: now.toISOString() }]) === 2);
check('local day key', /^\d{4}-\d\d-\d\d$/.test(localDay()));

// ---------------- end to end ----------------
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
await assertPortsFree([PUB, ADM, CDP_PORT], 'browser-test');
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
const api = (p, o = {}) => fetch(`http://127.0.0.1:${ADM}/api${p}`, { method: o.method || 'GET', headers: { 'content-type': 'application/json', authorization: `Bearer ${JSON.parse(fs.readFileSync(path.join(process.env.GWM_STATE_DIR, 'secrets.json'), 'utf8')).admin_token}` }, body: o.body ? JSON.stringify(o.body) : undefined }).then((r) => r.json());
const gemweb = (args) => new Promise((resolve) => {
  const ch = spawn(process.execPath, [GEMWEB, ...args], { env: { ...process.env, GEMWEB_FROM: 'btest' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '', err = ''; ch.stdout.on('data', (d) => { out += d; }); ch.stderr.on('data', (d) => { err += d; });
  ch.on('close', (code) => resolve({ code, out, err, id: /TASK_ID=(\S+)/.exec(err)?.[1] }));
});
const fakePages = async () => (await fetch(`${CDP}/json/list`).then((r) => r.json()).catch(() => [])).filter((t) => t.type === 'page' && t.url.startsWith(fake.url.replace(/\/app.*/, '')));
const registry = () => { try { return fs.readdirSync(path.join(process.env.GWM_STATE_DIR, 'run', 'tabs')); } catch { return []; } };
const task = (name) => `Write ${name}.\nMOCK write ${ROOT}/${name}\nhello from ${name}\nMOCK end\nMOCK run ${ROOT} :: cat ${name}`;

console.log('dispatch in the dedicated Chrome (fake Gemini page):');
let r = await gemweb(['--no-operator', '--timeout', '120', task('one.txt')]);
check('task finishes with the final report (exit 0)', r.code === 0 && /mock run for .* finished/.test(r.out), `code ${r.code}\n${r.out}\n${r.err}`);
let t = r.id ? await api(`/tasks/${r.id}`) : {};
check('ran in the dedicated Chrome (driver.browser = cdp, fast path)', t.driver?.browser === 'cdp' && t.driver?.path === 'fast', JSON.stringify(t.driver));
check('app selected with "@", Task mode on', fake.state.sends[0]?.mention === true && fake.state.sends[0]?.task_mode === true, JSON.stringify(fake.state.sends[0] || {}).slice(0, 200));
check('tool prompt answered with Always allow', fake.state.confirms[0] === 'Always allow', JSON.stringify(fake.state.confirms));
check('file written through MCP', fs.existsSync(path.join(ROOT, 'one.txt')));
check('task tab closed at the end', (await fakePages()).length === 0, JSON.stringify(await fakePages()));
check('tab registry cleaned up', registry().length === 0, registry());
check('task counted as sent today', !!t.sent_at);

console.log('Gemini model and thinking level (mode picker):');
r = await gemweb(['--no-operator', '--timeout', '120', '--model', 'Neon', '--effort', 'high', task('neon.txt')]);
let sN = fake.state.sends.at(-1) || {};
check('--model Neon --effort high: sent with Neon + High', r.code === 0 && sN.model === 'Neon' && sN.think === 'High', JSON.stringify({ code: r.code, model: sN.model, think: sN.think, err: r.err.slice(-300) }));
r = await gemweb(['--no-operator', '--timeout', '120', '--model', '4 Carbon', '--effort', 'low', task('carbon.txt')]);
sN = fake.state.sends.at(-1) || {};
check('--model "4 Carbon" --effort low: sent with Carbon + Low', r.code === 0 && sN.model === 'Carbon' && sN.think === 'Low', JSON.stringify({ code: r.code, model: sN.model, think: sN.think }));
{
  const before = fake.state.sends.length;
  r = await gemweb(['--no-operator', '--timeout', '60', '--model', 'Nonexistent9', 'hello']);
  check('unknown model: BLOCKED model-unavailable (exit 3) listing the offered models, nothing sent', r.code === 3 && /model-unavailable/.test(r.out + r.err) && /4 Neon/.test(r.out + r.err) && fake.state.sends.length === before, `${r.code} ${r.out} ${r.err.slice(-300)}`);
  r = await gemweb(['--no-operator', '--timeout', '60', '--effort', 'extreme', 'hello']);
  check('unknown thinking level: BLOCKED (exit 3), nothing sent', r.code === 3 && fake.state.sends.length === before, `${r.code} ${r.out}`);
}
{
  // the live quirk: thinking change, then a model switch in the same page -> picker ignores clicks until reload
  const { Dedicated } = await import('../src/browser.js');
  const { gemini } = await import('../src/sites.js');
  const d = await Dedicated.connect(cfgRef, 'mode_probe');
  const p = await d.newPage(); await p.goto(fake.url);
  const logs = [];
  let err = null;
  try {
    await gemini.selectMode(p, { model: 'Neon', effort: 'high', log: (m) => logs.push(m) });
    await gemini.selectMode(p, { model: 'Carbon', effort: 'medium', log: (m) => logs.push(m) });
  } catch (e) { err = e.message; }
  const st = await p.evaluate(() => [localStorage.getItem('fg-model'), localStorage.getItem('fg-think')]);
  check('second pick in the same new chat recovers by reloading (Carbon + Medium)', !err && st[0] === 'Carbon' && st[1] === 'Medium' && logs.some((m) => /reloading/.test(m)), JSON.stringify({ err, st, logs }));
  await p.evaluate(() => { localStorage.setItem('fg-model', 'Carbon'); localStorage.setItem('fg-think', 'Low'); });
  await p.close(); await d.closeTaskTabs(); await d.disconnect();
}

console.log('headless page looks like normal Chrome:');
{
  const { Dedicated } = await import('../src/browser.js');
  const d = await Dedicated.connect(cfgRef, 'ua_probe');
  const p = await d.newPage(); await p.goto(fake.url);
  const ua = await p.evaluate(() => navigator.userAgent + ' ' + JSON.stringify(navigator.userAgentData?.brands || []));
  check('navigator.userAgent / brands have no "Headless"', !/Headless/.test(ua), ua);
  await d.closeTaskTabs(); await d.disconnect();
  check('probe tab closed', (await fakePages()).length === 0);
}

console.log('crashed gemweb leaves no tab behind:');
{
  const child = `import { Dedicated } from ${JSON.stringify(path.join(REPO, 'src', 'browser.js'))};
const { loadConfig } = await import(${JSON.stringify(path.join(REPO, 'src', 'config.js'))});
const d = await Dedicated.connect(loadConfig(), 'orphan_t'); const p = await d.newPage(); await p.goto(${JSON.stringify(fake.url)}); process.kill(process.pid, 'SIGKILL');`;
  const f = path.join(TMP, 'orphan.mjs'); fs.writeFileSync(f, child);
  // async: the fake Gemini server lives in this process, a spawnSync would starve it
  const ocErr = await new Promise((resolve) => { let e = ''; const c = spawn(process.execPath, [f], { env: process.env, stdio: ['ignore', 'ignore', 'pipe'] }); c.stderr.on('data', (d) => { e += d; }); c.on('close', () => resolve(e)); });
  check('orphan tab exists after the kill', (await fakePages()).length === 1, JSON.stringify(await fakePages()) + ' ' + ocErr.slice(-400));
  const { Dedicated } = await import('../src/browser.js');
  const d = await Dedicated.connect(cfgRef, 'sweeper'); await d.disconnect();
  check('next gemweb run closes it', (await fakePages()).length === 0, JSON.stringify(await fakePages()));
  check('registry entry removed', !registry().includes('orphan_t.json'), registry());
}

console.log('not signed in:');
fake.state.mode = 'signedout';
r = await gemweb(['--no-operator', '--timeout', '60', task('two.txt')]);
check('BLOCKED: auth, pointing at webhub login gemini (exit 3)', r.code === 3 && /BLOCKED: auth\|.*webhub login gemini/.test(r.out), `${r.code} ${r.out} ${r.err}`);
check('no tab left', (await fakePages()).length === 0);
check('owner\'s Chrome not used as a fallback', !/Browser MCP/.test(r.err), r.err);

console.log('usage-limit notice stops new tasks:');
fake.state.mode = 'limit';
r = await gemweb(['--no-operator', '--timeout', '60', task('three.txt')]);
check('BLOCKED: rate-limit with the page notice (exit 3)', r.code === 3 && /BLOCKED: rate-limit\|.*reached your limit/.test(r.out), `${r.code} ${r.out} ${r.err}`);
check('no tab left', (await fakePages()).length === 0);
fake.state.mode = 'ok';
const sendsBefore = fake.state.sends.length;
r = await gemweb(['--no-operator', '--timeout', '60', task('four.txt')]);
check('next task refused before opening the browser (BLOCKED: rate-limit, no task id)', r.code === 3 && /BLOCKED: rate-limit\|.*paused until/.test(r.out) && !r.id && fake.state.sends.length === sendsBefore, `${r.code} ${r.out} ${r.err}`);
r = await gemweb(['limit']);
check('gemweb limit shows the pause', /paused until/.test(r.out), r.out + r.err);
r = await gemweb(['limit', 'clear']);
check('gemweb limit clear lifts it', /cleared/.test(r.out), r.out + r.err);
r = await gemweb(['--no-operator', '--timeout', '120', task('five.txt')]);
check('tasks run again after clear', r.code === 0, `${r.code} ${r.out} ${r.err}`);

console.log('daily cap (5 in this test):');
r = await gemweb(['status']);
check('gemweb status shows today\'s count', /today\s+gemini 5\/5 tasks sent/.test(r.out), r.out);
r = await gemweb(['--no-operator', '--timeout', '60', task('six.txt')]);
check('test clock is pinned to a fixed local day (midnight cannot split the run)', (await import('../src/quota.js')).localDay() === '2026-03-10' && new Date().getHours() >= 9, String(new Date()));
check('6th web task of the day refused: BLOCKED: daily-cap', r.code === 3 && /BLOCKED: daily-cap\|/.test(r.out), `${r.code} ${r.out} ${r.err}`);
r = await gemweb(['--driver', 'mock', '--timeout', '60', task('seven.txt')]);
check('mock-driver tasks do not count', r.code === 0, `${r.code} ${r.out} ${r.err}`);
const evs = await fetch(`http://127.0.0.1:${ADM}/api/events?limit=5000`).then((x) => x.json());
check('refusals and the limit are on the timeline', evs.some((e) => e.type === 'web.limit') && evs.some((e) => e.type === 'task.refused' && e.kind === 'daily-cap'));

// ---------------- cleanup ----------------
const exited = (p) => new Promise((r) => { if (p.exitCode !== null || p.signalCode) return r(); p.once('exit', r); setTimeout(r, 5000); });
server.kill('SIGTERM'); chromeProc.kill('SIGTERM'); await fake.close();
await Promise.all([exited(server), exited(chromeProc)]);
if (!process.argv.includes('--keep')) { try { fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 6, retryDelay: 200 }); } catch (e) { console.log(`cleanup: ${e.message}`); } } else console.log(`kept ${TMP}`);
if (fail) console.log(serverLog.split('\n').slice(-15).join('\n'));
console.log(`\n${fail ? '\x1b[31m' : '\x1b[32m'}${pass} passed, ${fail} failed\x1b[0m`);
process.exit(fail ? 1 : 0);
