#!/usr/bin/env node
// Tests for dangerous_policy "auto": risky commands run without approval, after a git snapshot
// (inside a repo) or a trash copy (outside git); roots / sandbox / hard-deny unchanged.
// Own server (temp state dir, ports 18781/18782).   node scripts/safety-test.mjs [--keep]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { reap, assertPortsFree } from './fixtures/reap.mjs';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(HERE, '..');
const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gwm-stest-')));
const ROOT = path.join(TMP, 'root'); const STATE = path.join(TMP, 'state');
const GITR = path.join(ROOT, 'repo'); const PLAIN = path.join(ROOT, 'plain');
for (const d of [ROOT, STATE, GITR, path.join(PLAIN, 'data')]) fs.mkdirSync(d, { recursive: true });
process.env.GWM_STATE_DIR = STATE;
const PUB = 18781, ADM = 18782;
fs.writeFileSync(path.join(STATE, 'config.json'), JSON.stringify({ public_port: PUB, admin_port: ADM, roots: [{ name: 'stest', path: ROOT }] })); // dangerous_policy: default
const g = (...a) => execFileSync('git', a, { cwd: GITR, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } }).trim();
g('init', '-q', '-b', 'work');
fs.writeFileSync(path.join(GITR, 'a.txt'), 'committed\n'); fs.writeFileSync(path.join(GITR, '.gitignore'), 'build/\n');
g('add', '-A'); g('commit', '-qm', 'init');
fs.writeFileSync(path.join(GITR, 'a.txt'), 'uncommitted edit\n');           // tracked change
fs.writeFileSync(path.join(GITR, 'u.txt'), 'untracked\n');                   // untracked
fs.mkdirSync(path.join(GITR, 'build')); fs.writeFileSync(path.join(GITR, 'build', 'out.bin'), 'ignored build output\n'); // ignored
fs.writeFileSync(path.join(PLAIN, 'data', 'x.txt'), 'plain data\n');
fs.writeFileSync(path.join(PLAIN, 'notes.txt'), 'old notes\n');
const headBefore = g('rev-parse', 'HEAD');

let pass = 0, fail = 0;
const check = (name, ok, detail = '') => { if (ok) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${name}`); } else { fail++; console.log(`  \x1b[31m✗ ${name}\x1b[0m ${String(detail).slice(0, 700)}`); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

console.log('delete targets:');
const { deleteTargets } = await import('../src/safety.js');
check('rm -rf a b/c', JSON.stringify(deleteTargets('rm -rf a b/c', '/r')) === JSON.stringify(['/r/a', '/r/b/c']));
check('find x -name y -delete, after &&', JSON.stringify(deleteTargets('cd /r && find out -name "*.o" -delete', '/r')) === JSON.stringify(['/r/out']));
check('~ expanded, $(…) not guessed', JSON.stringify(deleteTargets('rm -r ~/tmp/x "$(pwd)/y"', '/r')) === JSON.stringify([path.join(os.homedir(), 'tmp/x')]));

const { forcePushes } = await import('../src/safety.js');
const fp = (c) => JSON.stringify(forcePushes(c).map((x) => [x.dir, x.remote, x.branch]));
check('force-push parsing: git push -f / --force origin feat / -fu / +main / HEAD:main --force-with-lease / -C dir',
  fp('git push -f') === '[[null,null,null]]' && fp('git push --force origin feat') === '[[null,"origin","feat"]]' && fp('git push -fu origin feat') === '[[null,"origin","feat"]]'
  && fp('git push origin +main') === '[[null,"origin","main"]]' && fp('git push origin HEAD:refs/heads/main --force-with-lease') === '[[null,"origin","main"]]' && fp('cd x && git -C sub push -f up HEAD') === '[["sub","up",null]]',
  ['git push -f', 'git push --force origin feat', 'git push -fu origin feat', 'git push origin +main', 'git push origin HEAD:refs/heads/main --force-with-lease', 'cd x && git -C sub push -f up HEAD'].map(fp).join(' '));
check('plain pushes (incl. to main) are not force pushes', fp('git push origin main') === '[]' && fp('git push -u origin HEAD:main') === '[]' && fp('git status') === '[]');

await assertPortsFree([PUB, ADM], 'safety-test');
const server = reap(spawn(process.execPath, [path.join(REPO, 'src', 'server.js')], { env: process.env, stdio: ['ignore', 'pipe', 'pipe'] }));
let serverLog = ''; server.stdout.on('data', (d) => { serverLog += d; }); server.stderr.on('data', (d) => { serverLog += d; });
for (let i = 0; i < 50; i++) { if (await fetch(`http://127.0.0.1:${ADM}/api/state`).then((r) => r.ok).catch(() => false)) break; await sleep(200); }
const secrets = JSON.parse(fs.readFileSync(path.join(STATE, 'secrets.json'), 'utf8'));
const client = new Client({ name: 'safety-test', version: '1' });
await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${PUB}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${secrets.static_bearer}` } } }));
const call = async (name, args) => { const r = await client.callTool({ name, arguments: { task_id: 'stest', ...args } }); return { err: !!r.isError, text: r.content.map((x) => x.text).join('\n') }; };

console.log('inside a git repo:');
let t0 = Date.now();
let r = await call('run_command', { cwd: GITR, command: 'git reset --hard && git clean -fd && rm -rf build && echo wiped' });
check('runs without approval (no wait, no pending approval)', !r.err && /wiped/.test(r.text) && Date.now() - t0 < 20000 && (await fetch(`http://127.0.0.1:${ADM}/api/state`).then((x) => x.json())).pending.length === 0, r.text);
check('result names the snapshot', /\[safety: git snapshot [0-9a-f]{12}/.test(r.text), r.text.slice(0, 300));
check('command really ran (edit, untracked file, build gone)', fs.readFileSync(path.join(GITR, 'a.txt'), 'utf8') === 'committed\n' && !fs.existsSync(path.join(GITR, 'u.txt')) && !fs.existsSync(path.join(GITR, 'build')));
const refs = g('for-each-ref', '--format=%(refname) %(objectname)', 'refs/gemweb/snapshots/').split('\n').filter(Boolean);
check('one snapshot ref refs/gemweb/snapshots/…', refs.length === 1, refs);
const sha = refs[0]?.split(' ')[1];
check('snapshot holds the uncommitted edit and the untracked file', g('show', `${sha}:a.txt`) === 'uncommitted edit' && g('show', `${sha}:u.txt`) === 'untracked');
check('branch, HEAD and index untouched by the snapshot', g('rev-parse', '--abbrev-ref', 'HEAD') === 'work' && g('rev-parse', 'HEAD') === headBefore && g('status', '--porcelain') === '');
const evs = await fetch(`http://127.0.0.1:${ADM}/api/events?task_id=stest&limit=5000`).then((x) => x.json());
const snapEv = evs.find((e) => e.type === 'safety.snapshot');
check('ignored build/ copied to the trash (git does not keep it)', snapEv?.trash?.some((t) => t.path.endsWith('/build') && t.copy && fs.readFileSync(path.join(t.copy, 'out.bin'), 'utf8') === 'ignored build output\n'), JSON.stringify(snapEv?.trash));
check('timeline: confirm.auto with who / command / cwd', evs.some((e) => e.type === 'confirm.auto' && e.client && e.cwd === GITR && /git reset --hard/.test(e.command)));
g('restore', '--source', sha, '--worktree', '--', '.');
check('restore from the snapshot brings the edit and the untracked file back', fs.readFileSync(path.join(GITR, 'a.txt'), 'utf8') === 'uncommitted edit\n' && fs.existsSync(path.join(GITR, 'u.txt')));

console.log('force push keeps the remote branch:');
const BARE = path.join(ROOT, 'remote.git'); const OTHER = path.join(ROOT, 'other');
execFileSync('git', ['init', '-q', '--bare', BARE]);
g('remote', 'add', 'origin', BARE); g('push', '-q', '-u', 'origin', 'work');
const gx = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } }).trim();
execFileSync('git', ['clone', '-q', '-b', 'work', BARE, OTHER]);
fs.writeFileSync(path.join(OTHER, 'theirs.txt'), 'someone else\n'); gx(OTHER, 'add', '-A'); gx(OTHER, 'commit', '-qm', 'their work'); gx(OTHER, 'push', '-q', 'origin', 'work');
const theirs = gx(OTHER, 'rev-parse', 'HEAD');
fs.writeFileSync(path.join(GITR, 'mine.txt'), 'mine\n'); g('add', 'mine.txt'); g('commit', '-qm', 'my rewrite');
r = await call('run_command', { cwd: GITR, command: 'git push --force origin work 2>&1; echo pushed' });
check('force push runs without approval', !r.err && /pushed/.test(r.text) && gx(ROOT, '--git-dir', BARE, 'rev-parse', 'work') === g('rev-parse', 'HEAD'), r.text);
check('result names the remote commit it overwrote', r.text.includes(`origin/work was ${theirs.slice(0, 12)} before the force push`), r.text.slice(0, 400));
const fref = g('for-each-ref', '--format=%(refname) %(objectname)', 'refs/gemweb/force-push/').split('\n').filter(Boolean);
check('kept as a local ref refs/gemweb/force-push/<time>/origin/work (fetched: the commit was not local)', fref.length === 1 && /\/origin\/work /.test(fref[0]) && fref[0].endsWith(theirs) && g('show', `${theirs}:theirs.txt`) === 'someone else', fref);
const fev = (await fetch(`http://127.0.0.1:${ADM}/api/events?task_id=stest&limit=5000`).then((x) => x.json())).filter((e) => e.type === 'safety.snapshot' && e.force_push?.length).pop();
check('timeline: safety.snapshot with the old remote commit id', fev?.force_push[0]?.sha === theirs && fev.text.includes(theirs.slice(0, 12)), JSON.stringify(fev).slice(0, 400));
r = await call('run_command', { cwd: GITR, command: 'git push origin work 2>&1; echo pushed' });
check('plain push: no remote backup recorded', !r.err && !/before the force push/.test(r.text), r.text.slice(0, 300));

console.log('outside git:');
r = await call('run_command', { cwd: PLAIN, command: 'rm -rf data' });
const copy = /copied \S+ → ([^\]\s;]+)/.exec(r.text)?.[1];
check('rm -rf data runs and data is copied to ~/.gemini-web-mcp/trash/<date>/', !r.err && !fs.existsSync(path.join(PLAIN, 'data')) && copy?.startsWith(path.join(STATE, 'trash')) && fs.readFileSync(path.join(copy, 'x.txt'), 'utf8') === 'plain data\n', r.text);
r = await call('write_file', { path: path.join(PLAIN, 'notes.txt'), content: 'new notes\n' });
const tr = (await fetch(`http://127.0.0.1:${ADM}/api/events?task_id=stest&limit=5000`).then((x) => x.json())).find((e) => e.type === 'safety.trash');
check('write_file over a file outside git keeps the old version in the trash', !r.err && tr && fs.readFileSync(tr.copy, 'utf8') === 'old notes\n', JSON.stringify(tr));

console.log('unchanged guards:');
r = await call('run_command', { cwd: ROOT, command: 'sudo ls' });
check('sudo still refused', r.err && /DENIED/.test(r.text));
r = await call('run_command', { cwd: ROOT, command: 'rm -rf ~' });
check('rm -rf ~ still refused', r.err && /DENIED/.test(r.text));
r = await call('run_command', { cwd: '/tmp', command: 'rm -rf x' });
check('cwd outside the roots still refused', r.err);
r = await call('run_command', { cwd: ROOT, command: `rm -rf ${os.homedir()}/gwm-nonexistent-dir; touch ${os.homedir()}/gwm-sb-test; echo done` });
check('sandbox still blocks writes outside the roots', !fs.existsSync(path.join(os.homedir(), 'gwm-sb-test')), r.text);

console.log('trash retention:');
const old = path.join(STATE, 'trash', '2000-01-01', 'x'); fs.mkdirSync(old, { recursive: true });
const { Safety } = await import('../src/safety.js');
new Safety({ safety: { keep_days: 7 } }, { resolve: () => ({}) }, { emit() {} });
check('trash folders older than 7 days are removed', !fs.existsSync(path.join(STATE, 'trash', '2000-01-01')));

await client.close(); server.kill('SIGTERM');
if (!process.argv.includes('--keep')) fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 6, retryDelay: 200 }); else console.log(`kept ${TMP}`);
if (fail) console.log(serverLog.split('\n').slice(-15).join('\n'));
console.log(`\n${fail ? '\x1b[31m' : '\x1b[32m'}${pass} passed, ${fail} failed\x1b[0m`);
process.exit(fail ? 1 : 0);
