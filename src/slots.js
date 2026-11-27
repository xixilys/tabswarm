// Concurrency slots for gemweb: per (site, account) concurrency limit and start-interval
// throttling; remaining tasks wait FIFO. Mock-driver tasks skip the gap. A slot whose driver
// stops sending heartbeats (crashed gemweb) is reclaimed.
import { getAccount, resolveAccounts, DEFAULT_ACCOUNT } from './accounts.js';

export class Slots {
  constructor(cfg, tasks, events) {
    this.cfg = cfg; this.tasks = tasks; this.events = events;
    this.held = new Map(); // task_id -> last heartbeat
    this.queue = [];        // task ids waiting
    this.wakers = new Set();
    this.lastStart = {};     // `${site}:${account}` -> timestamp of last web (non-mock) start
    setInterval(() => this.sweep(), 15000).unref();
  }

  get limit() { return Math.max(1, Number(this.cfg.gemweb?.concurrency || 1)); }
  get gapMs() { return Math.max(0, Number(this.cfg.gemweb?.min_interval_sec ?? 60)) * 1000; }

  _site(id) { return this.tasks.get(id)?.site || 'gemini'; }
  _account(id) { return this.tasks.get(id)?.account || DEFAULT_ACCOUNT; }
  _key(site, account) { return `${site || 'gemini'}:${account || DEFAULT_ACCOUNT}`; }

  _limitFor(account) {
    try { return Math.max(1, Number(getAccount(this.cfg, account).concurrency ?? this.limit)); } catch { return this.limit; }
  }
  _gapFor(account) {
    try { return Math.max(0, Number(getAccount(this.cfg, account).min_interval_sec ?? (this.gapMs / 1000))) * 1000; } catch { return this.gapMs; }
  }
  _gapLeft(t) {
    if (t.mock) return 0;
    const k = this._key(t.site || 'gemini', t.account || DEFAULT_ACCOUNT);
    return Math.max(0, (this.lastStart[k] || 0) + this._gapFor(t.account || DEFAULT_ACCOUNT) - Date.now());
  }

  runningCount(site, account = DEFAULT_ACCOUNT) {
    const wantAcct = account || DEFAULT_ACCOUNT;
    return [...this.held.keys()].filter((id) => this._site(id) === site && this._account(id) === wantAcct).length;
  }

  _first(site, account) {
    const wantAcct = account || DEFAULT_ACCOUNT;
    return this.queue.find((id) => this._site(id) === site && this._account(id) === wantAcct);
  }

  async acquire(t, waitMs) {
    if (this.held.has(t.id)) { this.beat(t.id); return { granted: true, position: 0 }; }
    const acct = t.account || DEFAULT_ACCOUNT;
    const lim = this._limitFor(acct);
    if (!this.queue.includes(t.id)) {
      this.queue.push(t.id);
      this.events.emit('task.queued', { task_id: t.id, site: t.site || 'gemini', account: acct, position: this.queue.length, running: this.held.size, limit: lim });
    }
    t.queue_beat = Date.now();
    const deadline = Date.now() + waitMs;
    for (;;) {
      const site = t.site || 'gemini';
      const k = this._key(site, acct);
      const acctLim = this._limitFor(acct);
      const runningSiteAcct = this.runningCount(site, acct);
      if (this._first(site, acct) === t.id && runningSiteAcct < acctLim && !this._gapLeft(t)) {
        this.queue = this.queue.filter((x) => x !== t.id); this.held.set(t.id, Date.now());
        if (!t.mock) this.lastStart[k] = Date.now();
        this.events.emit('task.slot', { task_id: t.id, site, account: acct, running: this.held.size, limit: acctLim });
        this._wakeAll();
        return { granted: true, position: 0 };
      }
      const left = deadline - Date.now();
      if (left <= 0) {
        return {
          granted: false,
          position: this.queue.indexOf(t.id) + 1,
          running: runningSiteAcct,
          limit: acctLim,
          wait_sec: Math.ceil(this._gapLeft(t) / 1000),
        };
      }
      await new Promise((r) => {
        const tm = setTimeout(done, Math.min(left, 5000, this._gapLeft(t) || 5000));
        const self = this;
        function done() { clearTimeout(tm); self.wakers.delete(done); r(); }
        this.wakers.add(done);
      });
      t.queue_beat = Date.now();
    }
  }

  _wakeAll() { for (const w of [...this.wakers]) w(); }
  beat(id) { if (this.held.has(id)) this.held.set(id, Date.now()); }

  release(id) {
    const had = this.held.delete(id);
    this.queue = this.queue.filter((x) => x !== id);
    if (had) this.events.emit('task.slot_released', { task_id: id, running: this.held.size, limit: this.limit });
    this._wakeAll();
  }

  sweep() {
    const now = Date.now();
    for (const [id, beat] of this.held) {
      const t = this.tasks.get(id);
      if (!t || now - beat > 180000 || !this.tasks.isActive(t)) {
        if (t && now - beat > 180000 && this.tasks.isActive(t)) this.tasks.setStatus(t, 'abandoned', { error: 'driver heartbeat lost' });
        this.release(id);
      }
    }
    // Drop queued entries whose gemweb process went away.
    this.queue = this.queue.filter((id) => { const t = this.tasks.get(id); return t && now - (t.queue_beat || 0) < 120000; });
  }

  summary() {
    const accounts = resolveAccounts(this.cfg);
    const by_account = {};
    for (const a of accounts) {
      by_account[a.name] = {};
      for (const site of ['gemini', 'chatgpt']) {
        by_account[a.name][site] = {
          limit: a.concurrency,
          running: [...this.held.keys()].filter((id) => this._site(id) === site && this._account(id) === a.name),
          queued: this.queue.filter((id) => this._site(id) === site && this._account(id) === a.name),
        };
      }
    }
    const by_site = {};
    for (const site of ['gemini', 'chatgpt']) {
      const activeForSite = accounts.filter((a) => a.enabled && a.sites.includes(site));
      const siteLimit = activeForSite.length
        ? activeForSite.reduce((n, a) => n + Math.max(1, a.concurrency || this.limit), 0)
        : this.limit;
      by_site[site] = {
        limit: siteLimit,
        running: [...this.held.keys()].filter((id) => this._site(id) === site),
        queued: this.queue.filter((id) => this._site(id) === site),
      };
    }
    return {
      limit: this.limit,
      min_interval_sec: this.gapMs / 1000,
      running: [...this.held.keys()],
      queued: [...this.queue],
      by_site,
      by_account,
    };
  }
}
