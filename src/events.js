// Event log: every observable thing (tool calls, streamed output, diffs, denials,
// reports, task lifecycle) is one event. Events go to an append-only JSONL file
// (one per day) and to live subscribers (status page SSE, `gemweb watch`).
import fs from 'node:fs';
import path from 'node:path';

const FIELD_CAP = 256 * 1024; // cap any single string field written to the log

function capStrings(v, depth = 0) {
  if (typeof v === 'string') return v.length > FIELD_CAP ? v.slice(0, FIELD_CAP) + `\n…[truncated ${v.length - FIELD_CAP} chars]` : v;
  if (depth > 6 || v === null || typeof v !== 'object') return v;
  if (Array.isArray(v)) return v.map((x) => capStrings(x, depth + 1));
  const o = {};
  for (const [k, x] of Object.entries(v)) o[k] = capStrings(x, depth + 1);
  return o;
}

export function dayFile(dir, d = new Date()) {
  const s = d.toISOString().slice(0, 10);
  return path.join(dir, `events-${s}.jsonl`);
}

export class EventLog {
  constructor(dir, { ringSize = 20000 } = {}) {
    this.dir = dir;
    this.ring = [];
    this.ringSize = ringSize;
    this.subs = new Set();
    this.seq = 0;
    this.bootId = Date.now().toString(36);
    this._loadTail();
  }

  _loadTail() {
    // Reload the last two days so the status page shows history across restarts.
    const files = fs.existsSync(this.dir) ? fs.readdirSync(this.dir).filter((f) => /^events-.*\.jsonl$/.test(f)).sort().slice(-2) : [];
    for (const f of files) {
      const lines = fs.readFileSync(path.join(this.dir, f), 'utf8').split('\n');
      for (const line of lines) {
        if (!line.trim()) continue;
        try { const ev = JSON.parse(line); this._push(ev); if (typeof ev.seq === 'number') this.seq = Math.max(this.seq, ev.seq); } catch { /* skip */ }
      }
    }
  }

  _push(ev) {
    this.ring.push(ev);
    if (this.ring.length > this.ringSize) this.ring.splice(0, this.ring.length - this.ringSize);
  }

  emit(type, data = {}) {
    const ev = { seq: ++this.seq, ts: new Date().toISOString(), type, ...capStrings(data) };
    try { fs.appendFileSync(dayFile(this.dir), JSON.stringify(ev) + '\n'); } catch (e) { console.error('log write failed', e.message); }
    this._push(ev);
    for (const fn of this.subs) { try { fn(ev); } catch { /* ignore */ } }
    return ev;
  }

  subscribe(fn) { this.subs.add(fn); return () => this.subs.delete(fn); }

  query({ task_id, since = 0, limit = 2000, types } = {}) {
    let out = this.ring.filter((e) => e.seq > since && (!task_id || e.task_id === task_id) && (!types || types.includes(e.type)));
    if (out.length > limit) out = out.slice(-limit);
    return out;
  }
}
