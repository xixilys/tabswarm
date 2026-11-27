// Tasks, per-task file tracking/conflict detection, and pending approvals.
import fs from 'node:fs';
import path from 'node:path';
import { newId, sha256 } from './config.js';

const ACTIVE = new Set(['queued', 'starting', 'running', 'dispatched', 'active']);

export class TaskStore {
  constructor(dir, events) {
    this.dir = dir; this.events = events; this.tasks = new Map(); this.waiters = new Map();
    for (const f of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
      if (!f.endsWith('.json')) continue;
      try { const t = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); this.tasks.set(t.id, t); } catch { /* skip */ }
    }
    // Tasks that were mid-flight when the server died are no longer driven by anyone.
    for (const t of this.tasks.values()) {
      if (['timeout', 'interrupted'].includes(t.status) && t.final?.status === 'final') {
        t.status = 'done';
        if (t.error) { t.late_note = t.error; t.error = null; }
        this.save(t);
      } else if (['queued', 'starting', 'dispatched', 'running'].includes(t.status) && t.origin === 'gemweb') {
        t.status = 'interrupted';
        this.save(t);
      }
      if (t.origin === 'mcp' && t.status === 'active' && Date.now() - Date.parse(t.last_activity || t.created || 0) >= 30 * 60 * 1000) {
        t.status = 'done';
        if (!t.ended) t.ended = t.last_activity || t.updated || new Date().toISOString();
        this.save(t);
      }
    }
  }

  save(t) {
    t.updated = new Date().toISOString();
    fs.writeFileSync(path.join(this.dir, `${t.id}.json`), JSON.stringify(t, null, 2));
  }

  create({ id, title, prompt, from, origin = 'gemweb', chat_url = null, status = 'queued', cwd = null, mock = false, site = 'gemini', account = 'default', client = null, client_id = null }) {
    const t = {
      id: id || newId('t', 4), title: title || (prompt || '').split('\n')[0].slice(0, 80) || '(untitled)', prompt: prompt || '',
      from: from || 'unknown', origin, status, chat_url, created: new Date().toISOString(), started: null, ended: null,
      tool_calls: 0, denied_calls: 0, files_changed: [], reports: [], final: null, driver: {}, conflicts: [],
      files_seen: {}, cwd, mock: !!mock, sent_at: null, site, account: account || 'default', client: client || null, client_id: client_id || null,
    };
    this.tasks.set(t.id, t); this.save(t);
    this.events.emit('task.created', { task_id: t.id, title: t.title, from: t.from, origin, site, account: t.account, prompt: t.prompt, status });
    return t;
  }

  get(id) { return this.tasks.get(id); }

  _clientSite(clientLabel) {
    const s = String(clientLabel || '');
    if (/chatgpt|openai/i.test(s)) return { site: 'chatgpt', label: 'ChatGPT' };
    if (/google|gemini/i.test(s)) return { site: 'gemini', label: 'Gemini' };
    const slug = s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 20) || 'web';
    return { site: slug, label: s || 'Web' };
  }

  // Tool calls name a task; calls without a task_id split cleanly into per-OAuth-client manual sessions.
  ensure(id, clientLabel, clientId = null) {
    const raw = id && String(id).trim();
    const { site, label } = this._clientSite(clientLabel);
    let t = raw ? this.tasks.get(raw) : null;
    if (!raw) {
      const prefix = `manual_${site}_`;
      const cutoff = Date.now() - 20 * 60 * 1000;
      const recent = [...this.tasks.values()]
        .filter((x) => x.origin === 'mcp' && x.id.startsWith(prefix) && x.status !== 'cancelled'
          && (!clientId || !x.client_id || x.client_id === clientId)
          && Date.parse(x.last_activity || x.created || 0) >= cutoff)
        .sort((a, b) => (b.last_activity || b.created || '').localeCompare(a.last_activity || a.created || ''));
      t = recent[0] || this.create({
        id: newId(`manual_${site}`, 3),
        title: `Manual ${label} chat`,
        from: clientLabel || site,
        origin: 'mcp',
        status: 'active',
        site,
        account: null,
        client: clientLabel || null,
        client_id: clientId || null,
      });
    } else if (!t) {
      t = this.create({
        id: raw,
        title: raw === 'manual' ? `Manual ${label} chat (no task_id)` : `Ad-hoc ${raw}`,
        from: clientLabel || site,
        origin: 'mcp',
        status: 'active',
        site,
        account: null,
        client: clientLabel || null,
        client_id: clientId || null,
      });
    }
    if (clientLabel && !t.client) t.client = clientLabel;
    if (clientId && !t.client_id) t.client_id = clientId;
    if (t.origin === 'gemweb' && ['queued', 'starting', 'dispatched'].includes(t.status)) this.setStatus(t, 'running');
    this.touch(t);
    return t;
  }

  updateStage(t, stage, detail = null) {
    if (!stage) return;
    t.driver ||= {};
    const prevStage = t.driver.stage;
    const prevDetail = t.driver.stage_detail ?? null;
    const now = new Date().toISOString();
    t.driver.stage = stage;
    t.driver.stage_detail = detail;
    t.driver.stage_updated_at = now;
    if (prevStage !== stage || prevDetail !== detail) {
      t.driver.stage_since = now;
      this.save(t);
      this.events.emit('task.stage', { task_id: t.id, stage, detail });
    }
  }

  setStatus(t, status, extra = {}) {
    const prev = t.status;
    if (prev === status && !Object.keys(extra).length) return;
    t.status = status; Object.assign(t, extra);
    if (status === 'running' && !t.started) t.started = new Date().toISOString();
    if (!ACTIVE.has(status) && !t.ended) t.ended = new Date().toISOString();
    this.save(t);
    this.events.emit('task.status', { task_id: t.id, status, prev, ...extra });
    this._wake(t);
  }

  addReport(t, rep) {
    t.reports.push(rep);
    if (rep.status === 'final' || rep.status === 'blocked') {
      t.final = rep;
      if (ACTIVE.has(t.status)) {
        this.save(t);
        this.setStatus(t, rep.status === 'final' ? 'reported' : 'blocked');
        return;
      }
      if (['timeout', 'interrupted'].includes(t.status)) {
        this.save(t);
        this.setStatus(t, rep.status === 'final' ? 'done' : 'blocked', { error: null });
        return;
      }
    }
    this.save(t); this._wake(t);
  }

  _wake(t) { for (const fn of this.waiters.get(t.id) || []) fn(); }

  waitChange(id, ms) {
    return new Promise((resolve) => {
      const set = this.waiters.get(id) || new Set(); this.waiters.set(id, set);
      const done = () => { clearTimeout(timer); set.delete(done); resolve(); };
      const timer = setTimeout(done, ms); set.add(done);
    });
  }

  list() { return [...this.tasks.values()].sort((a, b) => (b.created || '').localeCompare(a.created || '')); }
  isActive(t) {
    if (t.origin === 'mcp') return ACTIVE.has(t.status) && Date.now() - Date.parse(t.last_activity || t.created) < 30 * 60 * 1000;
    return ACTIVE.has(t.status);
  }
  touch(t) { t.last_activity = new Date().toISOString(); }

  // ---- file guard ----
  noteSeen(t, abs, content) { t.files_seen[abs] = content === null ? null : sha256(content); }

  // Returns null if the write may proceed, or a conflict description.
  checkWrite(t, abs, currentContent) {
    for (const other of this.tasks.values()) {
      if (other.id === t.id || !this.isActive(other)) continue;
      if (other.files_changed.includes(abs)) {
        return { kind: 'owned_by_other_task', other_task: other.id, message: `file is being modified by active task ${other.id} (${other.title}); coordinate or wait for it to finish` };
      }
    }
    const seen = t.files_seen[abs];
    if (seen !== undefined) {
      const now = currentContent === null ? null : sha256(currentContent);
      if (seen !== now) return { kind: 'changed_since_read', message: 'file changed on disk since this task last read/wrote it; re-read it before editing' };
    }
    return null;
  }

  recordConflict(t, abs, c, call_id) {
    const entry = { path: abs, ...c, at: new Date().toISOString() };
    t.conflicts.push(entry); this.save(t);
    this.events.emit('conflict', { task_id: t.id, call_id, path: abs, ...c });
    if (c.other_task) { const o = this.tasks.get(c.other_task); if (o) { o.conflicts.push({ ...entry, other_task: t.id, message: `task ${t.id} (${t.title}) tried to modify this file and was refused` }); this.save(o); } }
  }

  noteChanged(t, abs, newContent) {
    if (!t.files_changed.includes(abs)) t.files_changed.push(abs);
    this.noteSeen(t, abs, newContent); this.save(t);
  }
}

export class Approvals {
  constructor(cfg, events) { this.cfg = cfg; this.events = events; this.pending = new Map(); this.granted = new Map(); }

  _key(task_id, command, cwd) { return sha256(`${task_id}\0${cwd}\0${command}`); }

  // Resolves true (approved) / false (denied or timed out).
  async request({ task_id, call_id, command, cwd, reasons }) {
    const key = this._key(task_id, command, cwd);
    const g = this.granted.get(key);
    if (g && g > Date.now()) { this.granted.delete(key); this.events.emit('confirm.used', { task_id, call_id, command }); return { approved: true, how: 'pre-approved' }; }
    const id = newId('c', 4);
    const p = { id, task_id, call_id, command, cwd, reasons, key, created: Date.now(), expires: Date.now() + this.cfg.confirm_wait_sec * 1000 };
    this.pending.set(id, p);
    this.events.emit('confirm.pending', { task_id, call_id, confirm_id: id, command, cwd, reasons, wait_sec: this.cfg.confirm_wait_sec });
    const verdict = await new Promise((resolve) => {
      p.resolve = resolve;
      p.timer = setTimeout(() => resolve({ approved: false, how: 'timeout' }), this.cfg.confirm_wait_sec * 1000);
    });
    clearTimeout(p.timer);
    if (verdict.how === 'timeout') p.timedOut = true; else this.pending.delete(id);
    if (verdict.how === 'timeout') {
      // Keep it on the page so the owner can still approve; a late approval is stored for a retry.
      setTimeout(() => this.pending.delete(id), this.cfg.approval_ttl_sec * 1000).unref();
    }
    this.events.emit('confirm.resolved', { task_id, call_id, confirm_id: id, approved: verdict.approved, how: verdict.how });
    return verdict;
  }

  decide(id, approved, by = 'status-page') {
    const p = this.pending.get(id);
    if (!p) return false;
    this.pending.delete(id);
    if (p.timedOut) {
      if (approved) this.granted.set(p.key, Date.now() + this.cfg.approval_ttl_sec * 1000);
      this.events.emit('confirm.late', { task_id: p.task_id, confirm_id: id, approved, by, command: p.command });
    } else {
      p.resolve({ approved, how: by });
    }
    return true;
  }

  list() { return [...this.pending.values()].map(({ resolve, timer, key, ...rest }) => rest); }
}
