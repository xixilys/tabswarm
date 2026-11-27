// Command execution: sandboxed, process-group managed jobs with streamed output.
// A call blocks at most `waitSec`; long commands keep running as a job that the
// caller polls with command_output (keeps every HTTP request under Cloudflare's 100s).
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { expandHome, newId } from './config.js';

function real(p) { try { return fs.realpathSync(p); } catch { return path.resolve(p); } }
const q = (s) => JSON.stringify(s); // SBPL strings use the same escaping as JSON for our paths

export function buildSandboxProfile(cfg, roots) {
  const writable = new Set([
    ...roots.map((r) => real(r.path)),
    '/private/tmp', '/private/var/folders', real(os.tmpdir()),
    ...(cfg.sandbox_extra_write || []).map((p) => real(expandHome(p))),
  ]);
  const denyRead = (cfg.sandbox_deny_read || []).map((p) => real(expandHome(p)));
  return [
    '(version 1)',
    '(allow default)',
    '(deny file-write* (subpath "/"))',
    `(allow file-write* ${[...writable].map((p) => `(subpath ${q(p)})`).join(' ')} (literal "/dev/null") (literal "/dev/tty") (regex #"^/dev/fd/") (regex #"^/dev/ttys"))`,
    denyRead.length ? `(deny file-read* file-write* ${denyRead.map((p) => `(subpath ${q(p)})`).join(' ')})` : '',
  ].join('\n');
}

export class JobManager {
  constructor(cfg, policyRoots, events) {
    this.cfg = cfg; this.events = events; this.jobs = new Map();
    this.profile = buildSandboxProfile(cfg, policyRoots);
  }

  start({ command, cwd, timeoutSec, env, task_id, call_id }) {
    const id = newId('job', 4);
    const baseEnv = {
      PATH: this.cfg.command_path, HOME: os.homedir(), LANG: process.env.LANG || 'en_US.UTF-8', TERM: 'dumb',
      USER: os.userInfo().username, TMPDIR: os.tmpdir(), GIT_TERMINAL_PROMPT: '0', NO_COLOR: '1', CI: '1',
      ...(env || {}),
    };
    const argv = this.cfg.sandbox
      ? ['/usr/bin/sandbox-exec', ['-p', this.profile, '/bin/bash', '-c', command]]
      : ['/bin/bash', ['-c', command]];
    const child = spawn(argv[0], argv[1], { cwd, env: baseEnv, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const job = {
      id, command, cwd, task_id, call_id, pid: child.pid, started: Date.now(), ended: null,
      exit_code: null, signal: null, timed_out: false, killed: false,
      out: '', readOffset: 0, waiters: new Set(), child,
    };
    const onData = (stream) => (buf) => {
      const chunk = buf.toString('utf8');
      job.out += stream === 'stderr' ? chunk : chunk; // interleaved, like a terminal
      if (job.out.length > 4 * 1024 * 1024) job.out = job.out.slice(-2 * 1024 * 1024);
      this.events.emit('tool.output', { task_id, call_id, job_id: id, stream, chunk });
    };
    child.stdout.on('data', onData('stdout'));
    child.stderr.on('data', onData('stderr'));
    const timer = setTimeout(() => { job.timed_out = true; this.kill(id); }, timeoutSec * 1000);
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      job.ended = Date.now(); job.exit_code = code; job.signal = signal;
      this.events.emit('job.end', { task_id, call_id, job_id: id, exit_code: code, signal, timed_out: job.timed_out, duration_ms: job.ended - job.started });
      for (const w of job.waiters) w();
      setTimeout(() => this.jobs.delete(id), 3600 * 1000).unref();
    });
    child.on('error', (e) => { job.out += `\n[spawn error] ${e.message}\n`; });
    this.jobs.set(id, job);
    return job;
  }

  kill(id) {
    const job = this.jobs.get(id);
    if (!job || job.ended) return false;
    job.killed = true;
    try { process.kill(-job.pid, 'SIGTERM'); } catch { /* gone */ }
    setTimeout(() => { if (!job.ended) { try { process.kill(-job.pid, 'SIGKILL'); } catch { /* gone */ } } }, 3000).unref();
    return true;
  }

  async wait(job, waitSec) {
    if (job.ended) return;
    await new Promise((resolve) => {
      const t = setTimeout(done, waitSec * 1000);
      function done() { clearTimeout(t); job.waiters.delete(done); resolve(); }
      job.waiters.add(done);
    });
  }

  // New output since the last read (or the tail if huge) + status.
  snapshot(job, maxChars) {
    let text = job.out.slice(job.readOffset);
    job.readOffset = job.out.length;
    let truncated = false;
    if (text.length > maxChars) { text = `…[${text.length - maxChars} earlier chars omitted]\n` + text.slice(-maxChars); truncated = true; }
    return {
      job_id: job.id, running: !job.ended, exit_code: job.exit_code, signal: job.signal, timed_out: job.timed_out,
      killed: job.killed, elapsed_sec: Math.round(((job.ended || Date.now()) - job.started) / 100) / 10, output: text, truncated,
    };
  }

  list() {
    return [...this.jobs.values()]
      .sort((a, b) => b.started - a.started)
      .map((j) => ({
        job_id: j.id,
        task_id: j.task_id,
        call_id: j.call_id,
        pid: j.pid,
        command: j.command,
        cwd: j.cwd,
        running: !j.ended,
        started: new Date(j.started).toISOString(),
        ended: j.ended ? new Date(j.ended).toISOString() : null,
        elapsed_sec: Math.round(((j.ended || Date.now()) - j.started) / 100) / 10,
        exit_code: j.exit_code,
        signal: j.signal,
        timed_out: j.timed_out,
        killed: j.killed,
        output_tail: j.out.slice(-800),
      }));
  }

  killByTask(taskId) {
    const killed = [];
    for (const j of this.jobs.values()) {
      if (!j.ended && j.task_id === taskId && this.kill(j.id)) killed.push(j.id);
    }
    return killed;
  }
}
