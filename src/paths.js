// Path policy: every file path a tool touches must resolve (after following
// symlinks) inside one of the configured roots and must not match deny_globs.
import fs from 'node:fs';
import path from 'node:path';
import { expandHome } from './config.js';

export class PathError extends Error {
  constructor(msg) { super(msg); this.code = 'PATH_DENIED'; }
}

function realpathDeep(p) {
  // realpath of the deepest existing ancestor + the not-yet-existing tail.
  let cur = p; const tail = [];
  for (;;) {
    try { return path.join(fs.realpathSync(cur), ...tail.reverse()); } catch {
      const parent = path.dirname(cur);
      if (parent === cur) return p;
      tail.push(path.basename(cur)); cur = parent;
    }
  }
}

export class PathPolicy {
  constructor(cfg) {
    this.roots = cfg.roots.map((r) => ({ ...r, real: realpathDeep(r.path) }));
    this.denyGlobs = cfg.deny_globs || [];
  }

  // Returns { abs, root, rel }. Relative paths resolve against the first root.
  resolve(p, { forWrite = false } = {}) {
    if (typeof p !== 'string' || !p.trim()) throw new PathError('path is required');
    let raw = expandHome(p.trim());
    // "rootname:sub/path" shorthand
    const m = /^([A-Za-z0-9_.-]+):(.*)$/.exec(raw);
    if (m && !raw.startsWith('/')) {
      const r = this.roots.find((x) => x.name === m[1]);
      if (r) raw = path.join(r.path, m[2]);
    }
    if (!path.isAbsolute(raw)) {
      if (!this.roots.length) throw new PathError('no roots configured');
      raw = path.join(this.roots[0].path, raw);
    }
    const norm = path.resolve(raw);
    const real = realpathDeep(norm);
    const root = this.roots.find((r) => real === r.real || real.startsWith(r.real + path.sep));
    if (!root) {
      throw new PathError(`path outside allowed roots: ${p} (allowed: ${this.roots.map((r) => r.path).join(', ')})`);
    }
    const rel = path.relative(root.real, real) || '.';
    for (const g of this.denyGlobs) {
      if (path.matchesGlob(rel, g) || path.matchesGlob(path.basename(rel), g.replace(/^\*\*\//, ''))) {
        throw new PathError(`path matches a protected pattern (${g}): ${p}`);
      }
    }
    if (forWrite && rel === '.') throw new PathError('cannot write the root itself');
    // Report the path the user knows (under the configured root path, not the realpath).
    const abs = path.join(root.path, rel === '.' ? '' : rel);
    return { abs, real, root, rel };
  }

  isDenied(absReal) {
    const root = this.roots.find((r) => absReal === r.real || absReal.startsWith(r.real + path.sep));
    if (!root) return true;
    const rel = path.relative(root.real, absReal) || '.';
    return this.denyGlobs.some((g) => path.matchesGlob(rel, g) || path.matchesGlob(path.basename(rel), g.replace(/^\*\*\//, '')));
  }
}
