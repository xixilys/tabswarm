// HTTP client for the local admin API (the hub server), shared by the CLI commands that run
// outside the server process: `ask`, `swarm`, `session`. Same contract as bin/webhub.mjs's api():
// JSON in/out, bearer = secrets.admin_token, errors carry .status and .body.
import fs from 'node:fs';
import path from 'node:path';
import { STATE_DIR, loadConfig } from './config.js';

function readJson(p, d = {}) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return d; } }

export function apiBase(cfg = loadConfig()) {
  return `http://${cfg.admin_host || '127.0.0.1'}:${cfg.admin_port || 8782}/api`;
}

// retrySec: keep retrying "connection refused" this long (rides out a server restart).
export function makeApi({ cfg = loadConfig(), retrySec = 0 } = {}) {
  const base = apiBase(cfg);
  const token = () => readJson(path.join(STATE_DIR, 'secrets.json')).admin_token || '';
  async function api(p, { method = 'GET', body } = {}) {
    const until = Date.now() + retrySec * 1000;
    for (;;) {
      let r;
      try {
        r = await fetch(base + p, { method, headers: { 'content-type': 'application/json', authorization: `Bearer ${token()}` }, body: body ? JSON.stringify(body) : undefined });
      } catch (e) {
        if (Date.now() < until) { await new Promise((res) => setTimeout(res, 3000)); continue; }
        throw Object.assign(new Error(`hub server not reachable at ${base} (${e.cause?.code || e.message}); start it with: webhub start`), { unreachable: true });
      }
      const text = await r.text();
      let j; try { j = JSON.parse(text); } catch { j = { raw: text }; }
      if (!r.ok) throw Object.assign(new Error(j.error || text || r.statusText), { status: r.status, body: j });
      return j;
    }
  }
  api.base = base;
  return api;
}

const ENDED = ['failed', 'abandoned', 'interrupted', 'cancelled'];

export async function waitFinal(api, id, timeoutSec, { quiet = false, onProgress } = {}) {
  const deadline = Date.now() + timeoutSec * 1000;
  let t = await api(`/tasks/${id}`);
  let last = null;
  while (!t.final && Date.now() < deadline && !ENDED.includes(t.status)) {
    t = await api(`/tasks/${id}/wait?wait=50&reports=${t.reports.length}`);
    const rep = t.reports.slice(-1)[0];
    if (rep && rep.status === 'progress' && rep.at !== last) {
      last = rep.at;
      if (onProgress) onProgress(rep);
      else if (!quiet) process.stderr.write(`[progress] ${rep.summary}\n`);
    }
  }
  return t;
}

// The answer text of a finished task (what `ask` prints on stdout).
export function answerOf(t) {
  const f = t?.final;
  if (!f) return '';
  if (f.source === 'page') return String(f.content || '').trim();
  return (f.content ? `${f.summary}\n\n${f.content}` : String(f.summary || '')).trim();
}

// Everything except the answer: tool calls, files, chat link, task id.
export function detailsOf(t) {
  const f = t.final || {};
  const extra = [];
  if (f.source === 'page') extra.push('answer: last reply on the page (the model did not call report)');
  if (f.tests) extra.push(`tests: ${f.tests}`);
  if (t.tool_calls) extra.push(`${t.tool_calls} tool calls${t.denied_calls ? `, ${t.denied_calls} denied` : ''}`);
  if (t.tool_summary?.length) extra.push(`what it did on this computer:\n${t.tool_summary.map((x) => '  ' + x).join('\n')}`);
  if (t.files_changed?.length) extra.push(`files changed:\n${t.files_changed.map((x) => '  ' + x).join('\n')}`);
  if (t.conflicts?.length) extra.push(`conflicts:\n${t.conflicts.map((c) => `  ${c.path}: ${c.message}`).join('\n')}`);
  if (t.chat_url) extra.push(`chat: ${t.chat_url}`);
  if (t.account && t.account !== 'default') extra.push(`account: ${t.account}`);
  extra.push(`task: ${t.id}`);
  return extra.join('\n');
}

// Classic `webhub run` output: answer, then "---" and the details, all on stdout.
export function printFinal(t, { out = (s) => console.log(s) } = {}) {
  if (!t.final) return;
  out(answerOf(t));
  out('\n---\n' + detailsOf(t));
}
