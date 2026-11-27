#!/usr/bin/env node
// Tests for gemweb goal: notification policy, browser choice for rounds, and an end-to-end
// offline goal (mock driver). The end-to-end part runs its own server (18791/18792) and goal
// runner (`gemweb goal daemon`) on a temp state dir, so it never touches the live hub.
//   node scripts/goal-test.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { reap, assertPortsFree } from './fixtures/reap.mjs';
import { fileURLToPath } from 'node:url';
import { QQ, roundArgs, goalDir, loadState } from '../src/goals.js';
import { browserMcpUnavailable, preferAlways, SEL } from '../src/driver.js';
import { BmSession } from '../src/bmcp.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const GEMWEB = path.join(HERE, '..', 'bin', 'gemweb.mjs');
const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gwm-gtest-')));
const ROOT = path.join(TMP, 'root'), STATE = path.join(TMP, 'state');
for (const d of [ROOT, STATE]) fs.mkdirSync(d, { recursive: true });
const PUB = 18791, ADM = 18792;
fs.writeFileSync(path.join(STATE, 'config.json'), JSON.stringify({ public_port: PUB, admin_port: ADM, roots: [{ name: 'gtest', path: ROOT }] }));
const ENV = { ...process.env, WEBHUB_STATE_DIR: STATE, GWM_STATE_DIR: STATE };
process.on('exit', () => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* ignore */ } });
let pass = 0, fail = 0;
const check = (name, ok, detail = '') => { if (ok) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${name}`); } else { fail++; console.log(`  \x1b[31m✗ ${name}\x1b[0m ${detail}`); } };

console.log('browser path:');
const st = { name: 'demo', cwd: '/tmp/demo', round: 3 };
const args = roundArgs({ gemwebPath: GEMWEB, st, n: 4, pf: '/tmp/p.md', timeout: 1800 });
check('rounds use the normal dispatch path (no --browser, no --driver)', !args.includes('--browser') && !args.includes('--driver'), args.join(' '));
check('a Browser MCP page timeout does not switch to the dsh-browser Chrome', !browserMcpUnavailable(new Error('✗ step 1: tab new https://gemini.google.com/app?hl=en — Timeout 30000ms exceeded.')));
check('Browser MCP not running -> fallback allowed', browserMcpUnavailable(new Error('Browser MCP not available: spawn npx ENOENT')));
check('extension not connected -> fallback allowed', browserMcpUnavailable(new Error("✗ the Browser MCP extension isn't connected")));

console.log('Gemini tool prompts:');
check('prefers Always allow over Allow once', JSON.stringify(preferAlways(["Don't allow", 'Allow once', 'Always allow'])) === '["Always allow"]');
check('falls back to Allow once, never Don\'t allow', JSON.stringify(preferAlways(["Don't allow", 'Allow once'])) === '["Allow once"]');
const cs = (page) => BmSession.prototype.confirmState.call({ eval: async () => page }, SEL.confirmButtons);
const B = (d) => [{ l: "Don't allow", d }, { l: 'Allow once', d }, { l: 'Always allow', d }];
check('answered (disabled) prompts are not clicked', (await cs({ bs: B(true), waiting: false, answered: true })).labels.length === 0);
check('open prompt offers its labels', (await cs({ bs: [...B(true), ...B(false)], waiting: true, answered: false })).labels.includes('Always allow'));
check('disabled prompt + "Waiting for your input" = stuck', (await cs({ bs: B(true), waiting: true, answered: false })).stuck === true);
check('disabled prompt after "You said Always allow" is not stuck', (await cs({ bs: B(true), waiting: true, answered: true })).stuck === false);

console.log('owner messages (QQ):');
const msgs = { done: QQ.done(st), needs_owner: QQ.needs_owner(st, 'NEEDS OWNER DECISION: 用 SQLite 还是 JSON 文件存数据？'), login: QQ.login(st) };
for (const [k, m] of Object.entries(msgs)) {
  check(`${k}: plain Chinese, no English error or command`, /[一-鿿]/.test(m) && !/BLOCKED|gemweb |dsh-browser|https?:|`|NEEDS OWNER/.test(m) && m.length < 220, m);
}

console.log('end to end (mock driver, own server + goal runner):');
await assertPortsFree([PUB, ADM], 'goal-test');
const server = reap(spawn(process.execPath, [path.join(HERE, '..', 'src', 'server.js')], { env: ENV, stdio: 'ignore' }));
for (let i = 0; i < 50; i++) { if (await fetch(`http://127.0.0.1:${ADM}/api/state`).then((r) => r.ok).catch(() => false)) break; await new Promise((r) => setTimeout(r, 200)); }
reap(spawn(process.execPath, [GEMWEB, 'goal', 'daemon'], { env: ENV, stdio: 'ignore' }));
const name = 'selftest-' + Date.now().toString(36);
const dir = path.join(ROOT, 'gwm-goal-selftest', name);
fs.mkdirSync(dir, { recursive: true });
const goal = `Write two files, one per round.\nMOCK run ${dir} :: n=$(ls part*.txt 2>/dev/null | wc -l | tr -d ' '); echo ok > part$((n+1)).txt`;
execFileSync(process.execPath, [GEMWEB, 'goal', 'start', '--name', name, '--cwd', dir, '--goal', goal, '--done', 'test -f part2.txt', '--driver', 'mock', '--quiet', '--max-rounds', '5'], { stdio: 'ignore', env: ENV });
const gd = goalDir(dir, name);
let s = loadState(gd);
for (let i = 0; i < 90 && s?.status === 'running'; i++) { await new Promise((r) => setTimeout(r, 2000)); s = loadState(gd); }
check('goal reaches done', s?.status === 'done', JSON.stringify({ status: s?.status, reason: s?.stop_reason }));
check('took 2 rounds, both with progress', s?.round === 2 && s.rounds.filter((r) => r.progress).length === 2, JSON.stringify(s?.rounds?.map((r) => [r.n, r.outcome, r.progress])));
check('round log written into GOAL.md', /- R2 .* check pass/.test(fs.readFileSync(path.join(gd, 'GOAL.md'), 'utf8')));
const token = JSON.parse(fs.readFileSync(path.join(STATE, 'secrets.json'), 'utf8')).admin_token;
const evs = await fetch(`http://127.0.0.1:${ADM}/api/events?task_id=goal:${name}`, { headers: { authorization: `Bearer ${token}` } }).then((r) => r.json()).catch(() => []);
check('goal events reached the status page', evs.some((e) => e.type === 'goal.round_end'), `${evs.length} events`);
check('a --quiet goal sends no QQ / bot message', !evs.some((e) => e.type === 'goal.notified'));
execFileSync(process.execPath, [GEMWEB, 'goal', 'forget', name], { stdio: 'ignore', env: ENV });

console.log(`\n${fail ? '\x1b[31m' : '\x1b[32m'}${pass} passed, ${fail} failed\x1b[0m`);
process.exit(fail ? 1 : 0);
