// Safety net for risky commands when dangerous_policy = "auto" (the default): they run without
// asking, but first
//   - inside a git repository: a snapshot commit of the whole working tree (tracked changes and
//     untracked, non-ignored files) is made with a temporary index — the current branch, index and
//     files are not touched — and kept as refs/gemweb/snapshots/<stamp>. Restore with
//       git -C <repo> restore --source <sha> --worktree -- <paths or .>
//   - targets of rm / find -delete that git does not cover (outside a repo, or git-ignored) are
//     copied to ~/.gemini-web-mcp/trash/<YYYY-MM-DD>/<stamp>/ first.
// write_file / edit_file overwriting a file outside git copy the old file to the trash too.
// Before a force push (--force, -f, --force-with-lease, +refspec) the remote branch's current
// commit is fetched and kept as refs/gemweb/force-push/<stamp>/<remote>/<branch>, and its id is
// written to the timeline, so an overwritten remote branch can be restored.
// Trash folders and refs/gemweb/* older than safety.keep_days (7) are removed.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { STATE_DIR, expandHome } from './config.js';
import { localDay } from './quota.js';

const GIT_ENV = { GIT_AUTHOR_NAME: 'gemweb', GIT_AUTHOR_EMAIL: 'gemweb@localhost', GIT_COMMITTER_NAME: 'gemweb', GIT_COMMITTER_EMAIL: 'gemweb@localhost', GIT_TERMINAL_PROMPT: '0' };

function git(args, { cwd, env = {}, timeoutMs = 60000 } = {}) {
  return new Promise((resolve) => {
    const ch = spawn('git', args, { cwd, env: { ...process.env, ...GIT_ENV, ...env, PATH: process.env.PATH || '/usr/bin:/bin:/opt/homebrew/bin' } });
    let out = '', err = '';
    ch.stdout.on('data', (b) => { out += b; }); ch.stderr.on('data', (b) => { err += b; });
    const t = setTimeout(() => ch.kill('SIGKILL'), timeoutMs);
    ch.on('close', (code) => { clearTimeout(t); resolve({ code, out: out.trim(), err: err.trim() }); });
    ch.on('error', (e) => { clearTimeout(t); resolve({ code: -1, out: '', err: e.message }); });
  });
}

const stamp = (d = new Date()) => d.toISOString().replace(/[-:]/g, '').replace(/\..*/, '').replace('T', '-');

// Paths a command deletes, as far as a simple reading of rm / find -delete goes (no shell expansion
// except ~ and plain globs). Relative paths are resolved against cwd.
export function deleteTargets(command, cwd) {
  const out = [];
  for (const seg of String(command).split(/&&|\|\||[;|\n]/)) {
    const toks = seg.trim().match(/'[^']*'|"[^"]*"|\S+/g) || [];
    const words = toks.map((t) => t.replace(/^['"]|['"]$/g, ''));
    let i = words.findIndex((w) => /(^|\/)(rm|find)$/.test(w));
    if (i < 0) continue;
    const cmd = path.basename(words[i]);
    const args = words.slice(i + 1);
    let picked = [];
    if (cmd === 'rm') picked = args.filter((a) => !a.startsWith('-'));
    else if (cmd === 'find' && args.includes('-delete')) picked = [args.find((a) => !a.startsWith('-')) || '.'];
    for (let p of picked) {
      if (/[`$()]/.test(p)) continue; // substitutions: not guessed
      p = expandHome(p.replace(/^\$HOME(?=\/|$)/, '~'));
      const abs = path.resolve(cwd, p);
      if (/[*?[]/.test(p)) { try { for (const m of fs.globSync(p, { cwd })) out.push(path.resolve(cwd, m)); } catch { /* no glob support */ } } else out.push(abs);
    }
  }
  return [...new Set(out)];
}

// Force pushes in a command: [{ dir, remote, branch }] (dir from git -C, remote/branch null = the
// current branch's upstream). Pushes without force flags or + refspecs are not listed.
export function forcePushes(command) {
  const out = [];
  for (const seg of String(command).split(/&&|\|\||[;|\n]/)) {
    const w = (seg.trim().match(/'[^']*'|"[^"]*"|\S+/g) || []).map((t) => t.replace(/^['"]|['"]$/g, ''));
    let i = w.findIndex((x) => /(^|\/)git$/.test(x));
    if (i < 0) continue;
    let dir = null;
    for (i++; i < w.length && w[i] !== 'push'; i++) {
      if (w[i] === '-C') dir = w[++i];
      else if (w[i] === '-c') i++;
      else if (!w[i].startsWith('-')) break;
    }
    if (w[i] !== 'push') continue;
    let force = false; const pos = [];
    const args = w.slice(i + 1);
    for (let k = 0; k < args.length; k++) {
      const a = args[k];
      if (a === '--force' || a.startsWith('--force-with-lease')) force = true;
      else if (/^-[a-zA-Z]+$/.test(a)) { if (a.includes('f')) force = true; if (/o$/.test(a)) k++; }
      else if (['--push-option', '--repo', '--receive-pack', '--exec'].includes(a)) k++;
      else if (!a.startsWith('-')) pos.push(a);
    }
    const remote = pos[0] || null;
    const specs = pos.slice(1);
    if (!specs.length) { if (force) out.push({ dir, remote, branch: null }); continue; }
    for (const s of specs) {
      if (!force && !s.startsWith('+')) continue;
      const r = s.replace(/^\+/, '');
      let dst = r.includes(':') ? r.slice(r.indexOf(':') + 1) : r;
      if (!dst || dst === 'HEAD' || dst.startsWith('-')) dst = null;
      out.push({ dir, remote, branch: dst ? dst.replace(/^refs\/heads\//, '') : null });
    }
  }
  return out;
}

function sizeUpTo(p, cap) {
  let total = 0;
  const walk = (q) => {
    if (total > cap) return;
    let st; try { st = fs.lstatSync(q); } catch { return; }
    if (st.isDirectory()) { for (const e of fs.readdirSync(q)) walk(path.join(q, e)); } else total += st.size;
  };
  walk(p);
  return total;
}

export class Safety {
  constructor(cfg, paths, events) {
    this.cfg = cfg; this.paths = paths; this.events = events;
    const s = cfg.safety || {};
    this.keepDays = Number(s.keep_days ?? 7);
    this.trashMax = Number(s.trash_max_mb ?? 500) * 1024 * 1024;
    this.trashDir = expandHome(s.trash_dir || path.join(STATE_DIR, 'trash'));
    this.purgeTrash();
    setInterval(() => this.purgeTrash(), 6 * 3600 * 1000).unref();
  }

  async gitTop(dir) {
    let d = dir; try { if (!fs.statSync(d).isDirectory()) d = path.dirname(d); } catch { d = path.dirname(d); }
    while (!fs.existsSync(d) && d !== path.dirname(d)) d = path.dirname(d);
    const r = await git(['rev-parse', '--show-toplevel'], { cwd: d, timeoutMs: 10000 });
    return r.code === 0 ? r.out : null;
  }

  // Snapshot commit of the working tree (temporary index; nothing in the repo changes but one ref).
  async gitSnapshot(top, label) {
    const idx = path.join(os.tmpdir(), `gwm-snap-${process.pid}-${Date.now()}.idx`);
    try {
      const head = await git(['rev-parse', '-q', '--verify', 'HEAD'], { cwd: top });
      if (head.code === 0) await git(['read-tree', 'HEAD'], { cwd: top, env: { GIT_INDEX_FILE: idx } });
      const add = await git(['add', '-A', '--', '.'], { cwd: top, env: { GIT_INDEX_FILE: idx }, timeoutMs: 120000 });
      if (add.code !== 0) return { ok: false, error: `git add: ${add.err.slice(0, 200)}` };
      const tree = await git(['write-tree'], { cwd: top, env: { GIT_INDEX_FILE: idx } });
      if (tree.code !== 0) return { ok: false, error: `git write-tree: ${tree.err.slice(0, 200)}` };
      const c = await git(['commit-tree', tree.out, ...(head.code === 0 ? ['-p', head.out] : []), '-m', `gemweb snapshot before: ${label}`.slice(0, 500)], { cwd: top });
      if (c.code !== 0) return { ok: false, error: `git commit-tree: ${c.err.slice(0, 200)}` };
      const ref = `refs/gemweb/snapshots/${stamp()}-${c.out.slice(0, 8)}`;
      const u = await git(['update-ref', ref, c.out], { cwd: top });
      if (u.code !== 0) return { ok: false, error: `git update-ref: ${u.err.slice(0, 200)}` };
      this.pruneRefs(top).catch(() => {});
      const headTree = head.code === 0 ? (await git(['rev-parse', 'HEAD^{tree}'], { cwd: top })).out : null;
      return { ok: true, repo: top, sha: c.out, ref, head: head.code === 0 ? head.out : null, uncommitted: tree.out !== headTree, restore: `git -C ${JSON.stringify(top)} restore --source ${c.out.slice(0, 12)} --worktree -- .` };
    } finally { try { fs.unlinkSync(idx); } catch { /* none */ } }
  }

  // Age is taken from the <stamp> in the ref name (a force-push backup points at an old commit).
  async pruneRefs(top) {
    const r = await git(['for-each-ref', '--format=%(refname) %(creatordate:unix)', 'refs/gemweb/'], { cwd: top });
    const cutoff = Date.now() / 1000 - this.keepDays * 86400;
    for (const line of r.out.split('\n').filter(Boolean)) {
      const [ref, ts] = line.split(' ');
      const m = /\/(\d{4})(\d\d)(\d\d)-(\d\d)(\d\d)(\d\d)/.exec(ref);
      const when = m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) / 1000 : Number(ts);
      if (when < cutoff) await git(['update-ref', '-d', ref], { cwd: top });
    }
  }

  // Keeps the remote branch's current commit before a force push overwrites it.
  async backupRemote(top, remote, branch) {
    if (!branch) {
      const b = await git(['symbolic-ref', '-q', '--short', 'HEAD'], { cwd: top });
      if (b.code !== 0) return { ok: false, error: 'detached HEAD: branch unknown' };
      const up = await git(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'], { cwd: top });
      branch = up.code === 0 && up.out.includes('/') ? up.out.slice(up.out.indexOf('/') + 1) : b.out;
      if (!remote && up.code === 0 && up.out.includes('/')) remote = up.out.slice(0, up.out.indexOf('/'));
    }
    if (!remote) remote = (await git(['config', `branch.${branch}.remote`], { cwd: top })).out || 'origin';
    const env = { GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND || 'ssh -o BatchMode=yes -o ConnectTimeout=15' };
    const ls = await git(['ls-remote', remote, `refs/heads/${branch}`], { cwd: top, env, timeoutMs: 45000 });
    const base = { remote, branch };
    if (ls.code !== 0) return { ...base, ok: false, error: `git ls-remote: ${(ls.err || 'failed').slice(0, 200)}` };
    const sha = ls.out.split(/\s/)[0];
    if (!sha) return { ...base, ok: true, sha: null, note: `${remote} has no branch ${branch} yet (nothing to overwrite)` };
    const ref = `refs/gemweb/force-push/${stamp()}/${remote.replace(/[^A-Za-z0-9._-]+/g, '_')}/${branch}`;
    const have = (await git(['cat-file', '-e', `${sha}^{commit}`], { cwd: top })).code === 0;
    if (!have) {
      const f = await git(['fetch', '--no-tags', '--no-write-fetch-head', remote, `+refs/heads/${branch}:${ref}`], { cwd: top, env, timeoutMs: 120000 });
      if (f.code !== 0) return { ...base, ok: false, sha, error: `git fetch: ${f.err.slice(0, 200)}` };
    } else {
      const u = await git(['update-ref', ref, sha], { cwd: top });
      if (u.code !== 0) return { ...base, ok: false, sha, error: `git update-ref: ${u.err.slice(0, 200)}` };
    }
    const kept = (await git(['rev-parse', '-q', '--verify', ref], { cwd: top })).out;
    return { ...base, ok: true, sha: kept || sha, ref, restore: `git -C ${JSON.stringify(top)} push --force ${remote} ${(kept || sha).slice(0, 12)}:refs/heads/${branch}` };
  }

  // Copies a file or folder into today's trash folder; returns the copy's path or a reason.
  toTrash(abs, tag) {
    if (!fs.existsSync(abs)) return { skipped: 'does not exist' };
    const size = sizeUpTo(abs, this.trashMax);
    if (size > this.trashMax) return { skipped: `larger than ${Math.round(this.trashMax / 1048576)} MB (safety.trash_max_mb)` };
    const dest = path.join(this.trashDir, localDay(), tag, abs.replace(/^\/+/, ''));
    fs.mkdirSync(path.dirname(dest), { recursive: true, mode: 0o700 });
    fs.cpSync(abs, dest, { recursive: true, preserveTimestamps: true, verbatimSymlinks: true });
    return { copy: dest, bytes: size };
  }

  purgeTrash() {
    let days = []; try { days = fs.readdirSync(this.trashDir); } catch { return; }
    const cutoff = localDay(new Date(Date.now() - this.keepDays * 86400000));
    for (const d of days) if (/^\d{4}-\d\d-\d\d$/.test(d) && d < cutoff) fs.rmSync(path.join(this.trashDir, d), { recursive: true, force: true });
  }

  inRoots(abs) { try { this.paths.resolve(abs); return true; } catch { return false; } }

  // Before a dangerous command runs without approval. Returns what was saved (also logged).
  async beforeCommand({ command, cwd, task_id, call_id }) {
    const tag = `${stamp()}-${call_id || 'call'}`;
    const out = { git: null, trash: [], notes: [], force_push: [] };
    const top = await this.gitTop(cwd);
    for (const fp of forcePushes(command)) {
      const ftop = await this.gitTop(path.resolve(cwd, expandHome(fp.dir || '.')));
      if (!ftop) { out.notes.push('force push outside a git repository: remote not recorded'); continue; }
      const b = await this.backupRemote(ftop, fp.remote, fp.branch).catch((e) => ({ ok: false, error: e.message }));
      out.force_push.push({ repo: ftop, ...b });
      if (!b.ok) out.notes.push(`remote branch before the force push not recorded: ${b.error}`);
    }
    if (top) {
      out.git = await this.gitSnapshot(top, command);
      if (!out.git.ok) out.notes.push(`git snapshot failed: ${out.git.error}`);
    }
    for (const target of deleteTargets(command, cwd)) {
      if (!this.inRoots(target) || !fs.existsSync(target)) continue;
      const ttop = await this.gitTop(target);
      // covered by the snapshot unless outside any repo, in another repo, or ignored by git
      if (ttop && ttop === top && out.git?.ok) {
        const ign = await git(['check-ignore', '-q', '--', target], { cwd: ttop, timeoutMs: 10000 });
        if (ign.code !== 0) continue;
      }
      try { out.trash.push({ path: target, ...this.toTrash(target, tag) }); } catch (e) { out.trash.push({ path: target, skipped: e.message }); }
    }
    const saved = [out.git?.ok ? `git snapshot ${out.git.sha.slice(0, 12)} (${out.git.ref})` : null,
      ...out.force_push.filter((f) => f.ok).map((f) => (f.sha ? `${f.remote}/${f.branch} was ${f.sha.slice(0, 12)} before the force push (kept as ${f.ref})` : f.note)), ...out.trash.filter((t) => t.copy).map((t) => `copied ${t.path} → ${t.copy}`)].filter(Boolean);
    const skipped = out.trash.filter((t) => t.skipped).map((t) => `${t.path}: ${t.skipped}`);
    out.summary = saved.length ? saved.join('; ') : top ? 'nothing to save' : 'not in a git repository and no rm/find -delete target to copy';
    this.events.emit('safety.snapshot', { task_id, call_id, command, cwd, repo: top, git: out.git, trash: out.trash, force_push: out.force_push, notes: [...out.notes, ...skipped], text: `before \`${String(command).slice(0, 120)}\`: ${out.summary}${skipped.length ? ` (not copied: ${skipped.join(', ')})` : ''}` });
    return out;
  }

  // Before write_file / edit_file overwrites an existing file outside git: keep the old version.
  async beforeOverwrite(abs, { task_id, call_id }) {
    if (!fs.existsSync(abs)) return null;
    const top = await this.gitTop(abs);
    if (top) {
      const tracked = await git(['ls-files', '--error-unmatch', '--', abs], { cwd: top, timeoutMs: 10000 });
      const dirty = tracked.code === 0 ? (await git(['diff', '--quiet', 'HEAD', '--', abs], { cwd: top, timeoutMs: 10000 })).code !== 0 : true;
      if (tracked.code === 0 && !dirty) return null; // the committed version is in git
    }
    const r = this.toTrash(abs, `${stamp()}-${call_id || 'write'}`);
    if (r.copy) this.events.emit('safety.trash', { task_id, call_id, path: abs, copy: r.copy, text: `kept the previous ${path.basename(abs)} in ${r.copy}` });
    return r;
  }
}
