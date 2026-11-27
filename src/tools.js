// MCP tool definitions. Every handler runs through `instrument`, which writes
// tool.start / tool.end events (full arguments, result summary, duration,
// denial reason) so the status page and `gemweb watch` show a live timeline.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { z } from 'zod';
import { createTwoFilesPatch } from 'diff';
import { newId } from './config.js';
import { PathError } from './paths.js';
import { classifyCommand } from './policy.js';

export const SERVER_INSTRUCTIONS = `Local Projects MCP: read/write files, search, run shell commands and inspect git in the owner's project directories on their Mac.
- Only paths under the allowed roots work (call list_roots first). Use absolute paths, or "<root-name>:relative/path".
- If the user's message contains a TASK_ID (looks like "t_xxxxxxxx"), pass it as task_id on EVERY tool call, and when you are done call report(task_id, status="final", ...) with your complete answer. Use status="blocked" if you cannot continue, and status="progress" for milestones.
- If no TASK_ID is given (manual chat), you may optionally pass a short consistent task_id (e.g. "chat_topic") across calls in the same conversation so your session is tracked separately in the monitor.
- Read a file before editing it; edit_file replaces exact text and returns a diff. Writes that conflict with another task are refused; re-read and retry or report it.
- run_command runs in bash with a timeout. If it returns running=true, call command_output(job_id) until it finishes. Some commands are always refused (sudo, rm -rf on / or home, …); other risky ones (rm -r, git reset --hard, git push, …) run after an automatic git snapshot / trash copy that the owner can restore.
- Tool calls per conversation are limited. Batch: one run_command with a short script beats ten small calls. Delegate tool-heavy work to agents (agent_spawn, or swarm_start for several at once) and wait with wait_sec instead of polling; spend your own calls on planning, coordinating and reviewing.`;

const TaskId = z.string().optional().describe('Task id from the user message (e.g. t_1a2b3c4d). Pass it on every call when present.');

function clip(s, n) { s = String(s ?? ''); return s.length > n ? s.slice(0, n) + `…[+${s.length - n} chars]` : s; }
function text(obj) { return { content: [{ type: 'text', text: typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2) }] }; }
function errText(msg) { return { content: [{ type: 'text', text: msg }], isError: true }; }

function readMaybe(abs) { try { return fs.readFileSync(abs, 'utf8'); } catch (e) { if (e.code === 'ENOENT') return null; throw e; } }
function isBinary(buf) { const n = Math.min(buf.length, 8000); for (let i = 0; i < n; i++) if (buf[i] === 0) return true; return false; }

function run(cmd, args, { cwd, timeoutMs = 30000, maxBytes = 2_000_000 } = {}) {
  return new Promise((resolve) => {
    const ch = spawn(cmd, args, { cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_PAGER: 'cat', PAGER: 'cat', LC_ALL: 'en_US.UTF-8' } });
    let out = '', err = '';
    ch.stdout.on('data', (b) => { if (out.length < maxBytes) out += b; });
    ch.stderr.on('data', (b) => { if (err.length < maxBytes) err += b; });
    const t = setTimeout(() => ch.kill('SIGKILL'), timeoutMs);
    ch.on('close', (code) => { clearTimeout(t); resolve({ code, out, err }); });
    ch.on('error', (e) => { clearTimeout(t); resolve({ code: -1, out, err: e.message }); });
  });
}

function unifiedDiff(rel, before, after) {
  return createTwoFilesPatch(`a/${rel}`, `b/${rel}`, before ?? '', after ?? '', '', '', { context: 3 });
}
function diffStat(d) {
  let add = 0, del = 0;
  for (const l of d.split('\n')) { if (l.startsWith('+') && !l.startsWith('+++')) add++; else if (l.startsWith('-') && !l.startsWith('---')) del++; }
  return { add, del };
}

export function registerTools(server, ctx, reqInfo) {
  const { cfg, paths, events, tasks, jobs, approvals } = ctx;
  const client = reqInfo.client || 'unknown';
  const clientId = reqInfo.client_id || null;

  function instrument(name, summarizeArgs, handler) {
    return async (args, extra) => {
      const call_id = newId('call', 4);
      const t = tasks.ensure(args.task_id, client, clientId);
      if (t.status === 'cancelled') {
        events.emit('tool.refused', { task_id: t.id, tool: name, reason: 'task cancelled' });
        return errText(`STOPPED: task ${t.id} was cancelled by the owner. Stop working on it now and do not call more tools.`);
      }
      const started = Date.now();
      const summary = summarizeArgs(args);
      t.tool_calls++;
      events.emit('tool.start', { task_id: t.id, call_id, tool: name, args, summary, client });
      ctx.inFlight?.set(call_id, { call_id, task_id: t.id, client, tool: name, summary, started_ms: started, started_at: new Date(started).toISOString() });
      const c = { task: t, call_id, extra };
      let res, denied = false, reason = null, info = {};
      try {
        const out = await handler(args, c);
        res = out.result; info = out.info || {}; denied = !!out.denied; reason = out.reason || null;
      } catch (e) {
        denied = e instanceof PathError; reason = e.message;
        res = errText(`${denied ? 'DENIED' : 'ERROR'}: ${e.message}`);
      } finally {
        ctx.inFlight?.delete(call_id);
      }
      if (denied) t.denied_calls++;
      tasks.save(t);
      const resultText = (res.content || []).map((x) => x.text).join('\n');
      events.emit('tool.end', {
        task_id: t.id, call_id, tool: name, ok: !res.isError, denied, reason, duration_ms: Date.now() - started,
        result_preview: clip(resultText, 4000), ...info,
      });
      return res;
    };
  }

  const ro = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
  const rw = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false };
  const noPrompt = (toolName) => {
    if (client === 'Google') {
      if (toolName === 'run_command') return cfg.gemini_run_command_no_prompt !== false && cfg.web_write_no_prompt !== false;
      return cfg.web_write_no_prompt !== false;
    }
    if (client === 'ChatGPT') return cfg.web_write_no_prompt !== false;
    return false;
  };
  const rwFor = (toolName, extra = {}) => ({ ...rw, ...extra, destructiveHint: !noPrompt(toolName) });

  server.registerTool('list_roots', {
    title: 'List allowed project roots',
    description: 'List the project root directories this server may access. Call this first.',
    inputSchema: { task_id: TaskId }, annotations: ro,
  }, instrument('list_roots', () => '', async () => ({
    result: text(paths.roots.map((r) => ({ name: r.name, path: r.path, exists: fs.existsSync(r.path) }))),
  })));

  server.registerTool('list_dir', {
    title: 'List directory',
    description: 'List entries of a directory inside an allowed root. depth>1 recurses (skips .git and node_modules).',
    inputSchema: {
      path: z.string().describe('Directory path (absolute, ~/..., or root:relative)'),
      depth: z.number().int().min(1).max(4).optional().describe('Recursion depth, default 1'),
      show_hidden: z.boolean().optional().describe('Include dotfiles, default false'),
      task_id: TaskId,
    }, annotations: ro,
  }, instrument('list_dir', (a) => a.path, async (a) => {
    const { abs } = paths.resolve(a.path);
    const depth = a.depth || 1; const lines = []; let count = 0;
    const walk = (dir, d, prefix) => {
      let ents = fs.readdirSync(dir, { withFileTypes: true });
      ents = ents.filter((e) => a.show_hidden || !e.name.startsWith('.')).sort((x, y) => (y.isDirectory() - x.isDirectory()) || x.name.localeCompare(y.name));
      for (const e of ents) {
        if (++count > 2000) { lines.push(`${prefix}… (truncated)`); return; }
        const p = path.join(dir, e.name);
        if (paths.isDenied(safeReal(p))) continue;
        let size = '';
        if (e.isFile()) { try { size = ` (${fs.statSync(p).size} B)`; } catch { /* */ } }
        lines.push(`${prefix}${e.name}${e.isDirectory() ? '/' : e.isSymbolicLink() ? '@' : ''}${size}`);
        if (e.isDirectory() && d < depth && !['.git', 'node_modules', '.venv', '__pycache__'].includes(e.name)) walk(p, d + 1, prefix + '  ');
      }
    };
    walk(abs, 1, '');
    return { result: text(`${abs}\n${lines.join('\n') || '(empty)'}`), info: { entries: count } };
  }));

  server.registerTool('read_file', {
    title: 'Read file',
    description: 'Read a text file inside an allowed root. Returns numbered lines. Use offset/limit (1-based lines) for large files.',
    inputSchema: {
      path: z.string().describe('File path'),
      offset: z.number().int().min(1).optional().describe('First line (1-based), default 1'),
      limit: z.number().int().min(1).max(5000).optional().describe('Max lines, default 800'),
      task_id: TaskId,
    }, annotations: ro,
  }, instrument('read_file', (a) => `${a.path}${a.offset ? `:${a.offset}` : ''}${a.limit ? `+${a.limit}` : ''}`, async (a, c) => {
    const { abs } = paths.resolve(a.path);
    const st = fs.statSync(abs);
    if (st.isDirectory()) return { result: errText(`${abs} is a directory; use list_dir`) };
    if (st.size > cfg.max_read_bytes * 10) return { result: errText(`file too large (${st.size} bytes)`) };
    const buf = fs.readFileSync(abs);
    if (isBinary(buf)) return { result: errText(`binary file (${st.size} bytes) not shown`) };
    const content = buf.toString('utf8');
    tasks.noteSeen(c.task, abs, content);
    const all = content.split('\n');
    const off = a.offset || 1; const lim = a.limit || 800;
    const slice = all.slice(off - 1, off - 1 + lim);
    let body = slice.map((l, i) => `${String(off + i).padStart(5)}  ${l}`).join('\n');
    if (body.length > cfg.max_read_bytes) body = body.slice(0, cfg.max_read_bytes) + '\n…[truncated]';
    const end = off - 1 + slice.length;
    const header = `${abs} (lines ${off}-${end} of ${all.length})${end < all.length ? ` — more: offset=${end + 1}` : ''}`;
    return { result: text(`${header}\n${body}`), info: { file: abs, lines: [off, end], total_lines: all.length } };
  }));

  async function applyWrite(c, abs, rel, before, after, mode) {
    const conflict = tasks.checkWrite(c.task, abs, readMaybe(abs));
    if (conflict) {
      tasks.recordConflict(c.task, abs, conflict, c.call_id);
      return { result: errText(`CONFLICT: ${conflict.message}`), denied: true, reason: `conflict: ${conflict.message}` };
    }
    if (before !== null && ctx.safety) await ctx.safety.beforeOverwrite(abs, { task_id: c.task.id, call_id: c.call_id }).catch(() => null);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    const tmp = `${abs}.gwm-${process.pid}-${Date.now()}.tmp`;
    fs.writeFileSync(tmp, after);
    try { const st = fs.statSync(abs); fs.chmodSync(tmp, st.mode); } catch { /* new file */ }
    fs.renameSync(tmp, abs);
    tasks.noteChanged(c.task, abs, after);
    const diff = unifiedDiff(rel, before, after);
    const stat = diffStat(diff);
    events.emit('file.changed', { task_id: c.task.id, call_id: c.call_id, path: abs, mode, created: before === null, diff, ...stat });
    return { diff, stat };
  }

  server.registerTool('write_file', {
    title: 'Write file',
    description: 'Create or overwrite a text file inside an allowed root. Returns a unified diff. Prefer edit_file for small changes.',
    inputSchema: {
      path: z.string().describe('File path'),
      content: z.string().describe('Full new file content'),
      task_id: TaskId,
    }, annotations: rwFor('write_file'),
  }, instrument('write_file', (a) => `${a.path} (${(a.content || '').length} chars)`, async (a, c) => {
    const { abs, rel } = paths.resolve(a.path, { forWrite: true });
    const before = readMaybe(abs);
    if (before !== null && c.task.files_seen[abs] === undefined) tasks.noteSeen(c.task, abs, before); // blind overwrite is allowed once
    const r = await applyWrite(c, abs, rel, before, a.content, 'write');
    if (r.result) return r;
    return { result: text(`${before === null ? 'Created' : 'Wrote'} ${abs} (+${r.stat.add} -${r.stat.del})\n\n${clip(r.diff, 20000)}`), info: { file: abs, ...r.stat } };
  }));

  server.registerTool('edit_file', {
    title: 'Edit file',
    description: 'Replace exact text in a file. Each edit\'s old_text must match exactly once (unless replace_all). Returns a unified diff. Set dry_run to preview.',
    inputSchema: {
      path: z.string().describe('File path'),
      edits: z.array(z.object({
        old_text: z.string().describe('Exact text to find (include enough context to be unique)'),
        new_text: z.string().describe('Replacement text'),
        replace_all: z.boolean().optional().describe('Replace every occurrence'),
      })).min(1).describe('Edits applied in order'),
      dry_run: z.boolean().optional().describe('Only show the diff, do not write'),
      task_id: TaskId,
    }, annotations: rwFor('edit_file'),
  }, instrument('edit_file', (a) => `${a.path} (${a.edits?.length || 0} edit${a.edits?.length === 1 ? '' : 's'}${a.dry_run ? ', dry run' : ''})`, async (a, c) => {
    const { abs, rel } = paths.resolve(a.path, { forWrite: true });
    const before = readMaybe(abs);
    if (before === null) return { result: errText(`file does not exist: ${abs} (use write_file to create)`) };
    let after = before;
    for (const [i, e] of a.edits.entries()) {
      const n = after.split(e.old_text).length - 1;
      if (n === 0) return { result: errText(`edit ${i + 1}: old_text not found in ${abs}`) };
      if (n > 1 && !e.replace_all) return { result: errText(`edit ${i + 1}: old_text matches ${n} times; add context or set replace_all`) };
      after = e.replace_all ? after.split(e.old_text).join(e.new_text) : after.replace(e.old_text, () => e.new_text);
    }
    if (a.dry_run) {
      const d = unifiedDiff(rel, before, after);
      return { result: text(`Dry run, not written:\n\n${clip(d, 20000)}`), info: { file: abs, dry_run: true, diff: d } };
    }
    if (c.task.files_seen[abs] === undefined) tasks.noteSeen(c.task, abs, before); // exact-match edits are safe without a prior read
    const r = await applyWrite(c, abs, rel, before, after, 'edit');
    if (r.result) return r;
    return { result: text(`Edited ${abs} (+${r.stat.add} -${r.stat.del})\n\n${clip(r.diff, 20000)}`), info: { file: abs, ...r.stat } };
  }));

  server.registerTool('search', {
    title: 'Search files',
    description: 'Search file contents (ripgrep) or file names under a directory inside an allowed root. Respects .gitignore.',
    inputSchema: {
      query: z.string().describe('Text or regex (content mode), or glob like "*.py" (filename mode)'),
      path: z.string().describe('Directory or file to search'),
      mode: z.enum(['content', 'filename']).optional().describe('Default content'),
      regex: z.boolean().optional().describe('Treat query as regex (content mode), default false = literal'),
      case_sensitive: z.boolean().optional().describe('Default false'),
      glob: z.string().optional().describe('Only files matching this glob, e.g. "*.ts"'),
      max_results: z.number().int().min(1).max(1000).optional().describe('Default 200'),
      task_id: TaskId,
    }, annotations: ro,
  }, instrument('search', (a) => `${a.mode === 'filename' ? 'files ' : ''}"${a.query}" in ${a.path}${a.glob ? ` [${a.glob}]` : ''}`, async (a) => {
    const { abs } = paths.resolve(a.path);
    const max = a.max_results || 200;
    const denyArgs = (cfg.deny_globs || []).flatMap((g) => ['-g', `!${g.replace(/^\*\*\//, '')}`]);
    let args;
    if (a.mode === 'filename') {
      args = ['--files', '-g', a.query.includes('/') || a.query.includes('*') ? a.query : `*${a.query}*`, ...(a.case_sensitive ? [] : ['--glob-case-insensitive']), ...denyArgs, abs];
    } else {
      args = ['-n', '--no-heading', '--color', 'never', '-M', '300', '--max-columns-preview', ...(a.regex ? [] : ['-F']), ...(a.case_sensitive ? ['-s'] : ['-i']), ...(a.glob ? ['-g', a.glob] : []), ...denyArgs, '--', a.query, abs];
    }
    const r = await run('rg', args, { timeoutMs: 30000 });
    if (r.code === 2 && !r.out) return { result: errText(`search error: ${r.err.trim()}`) };
    const lines = r.out.split('\n').filter(Boolean);
    const shown = lines.slice(0, max);
    return { result: text(`${lines.length} match${lines.length === 1 ? '' : 'es'}${lines.length > max ? ` (showing ${max})` : ''}\n${shown.join('\n')}`), info: { matches: lines.length } };
  }));

  async function runOrPoll(job, waitSec) {
    await jobs.wait(job, waitSec);
    const s = jobs.snapshot(job, cfg.max_output_chars);
    const status = s.running ? `still running after ${s.elapsed_sec}s — call command_output(job_id="${job.id}") to keep waiting` : `exit ${s.exit_code}${s.timed_out ? ' (timed out, killed)' : ''}${s.killed && !s.timed_out ? ' (killed)' : ''} in ${s.elapsed_sec}s`;
    return { result: text(`$ ${job.command}\n[cwd ${job.cwd}] ${status}\n\n${s.output || '(no output)'}`), info: { job_id: job.id, running: s.running, exit_code: s.exit_code, elapsed_sec: s.elapsed_sec }, s };
  }

  server.registerTool('run_command', {
    title: 'Run shell command',
    description: 'Run a bash command in a working directory inside an allowed root (sandboxed: writes only inside roots and temp dirs). Blocks up to wait_seconds; if still running, returns job_id for command_output. Dangerous commands are refused or need owner approval.',
    inputSchema: {
      command: z.string().describe('Bash command line'),
      cwd: z.string().describe('Working directory (inside an allowed root)'),
      timeout_seconds: z.number().int().min(1).optional().describe(`Kill after this many seconds (default ${cfg.command_timeout_default_sec}, max ${cfg.command_timeout_max_sec})`),
      wait_seconds: z.number().int().min(1).optional().describe(`Return after this long even if still running (default/max ${cfg.command_wait_max_sec})`),
      task_id: TaskId,
    }, annotations: rwFor('run_command', { openWorldHint: true }),
  }, instrument('run_command', (a) => `$ ${a.command}  (cwd ${a.cwd})`, async (a, c) => {
    const { abs: cwd } = paths.resolve(a.cwd);
    if (!fs.statSync(cwd).isDirectory()) return { result: errText(`cwd is not a directory: ${cwd}`) };
    const verdict = classifyCommand(a.command);
    if (verdict.level === 'deny') {
      return { result: errText(`DENIED: command refused by policy (${verdict.reasons.join(', ')})`), denied: true, reason: `policy: ${verdict.reasons.join(', ')}`, info: { policy: verdict } };
    }
    let saved = null;
    if (verdict.level === 'confirm' && cfg.dangerous_policy === 'auto') {
      // No approval (dangerous_policy = "auto"): save what the command could destroy, log who/what/where, run.
      saved = ctx.safety ? await ctx.safety.beforeCommand({ command: a.command, cwd, task_id: c.task.id, call_id: c.call_id }).catch((e) => ({ summary: `snapshot error: ${e.message}` })) : null;
      events.emit('confirm.auto', { task_id: c.task.id, call_id: c.call_id, client, command: a.command, cwd, reasons: verdict.reasons, saved: saved?.summary || null, text: `auto-allowed for ${client} in ${cwd}: \`${a.command.slice(0, 160)}\` (${verdict.reasons.join(', ')})` });
    } else if (verdict.level === 'confirm') {
      if (cfg.dangerous_policy !== 'confirm') {
        return { result: errText(`DENIED: dangerous command (${verdict.reasons.join(', ')}); this server refuses it`), denied: true, reason: `policy: ${verdict.reasons.join(', ')}`, info: { policy: verdict } };
      }
      const v = await approvals.request({ task_id: c.task.id, call_id: c.call_id, command: a.command, cwd, reasons: verdict.reasons });
      if (!v.approved) {
        const why = v.how === 'timeout' ? `needs the owner's approval on the local status page (${verdict.reasons.join(', ')}); not approved within ${cfg.confirm_wait_sec}s. Ask the user to approve, then retry the identical command.` : `owner denied (${verdict.reasons.join(', ')})`;
        return { result: errText(`DENIED: ${why}`), denied: true, reason: `approval ${v.how}: ${verdict.reasons.join(', ')}`, info: { policy: verdict } };
      }
    }
    const timeout = Math.min(a.timeout_seconds || cfg.command_timeout_default_sec, cfg.command_timeout_max_sec);
    const wait = Math.min(a.wait_seconds || cfg.command_wait_max_sec, cfg.command_wait_max_sec);
    const job = jobs.start({ command: a.command, cwd, timeoutSec: timeout, task_id: c.task.id, call_id: c.call_id });
    events.emit('job.start', { task_id: c.task.id, call_id: c.call_id, job_id: job.id, command: a.command, cwd, timeout_sec: timeout, sandbox: cfg.sandbox, policy: verdict });
    const r = await runOrPoll(job, wait);
    if (saved?.summary && r.result?.content?.[0]) r.result.content[0].text = `[safety: ${saved.summary}]\n${r.result.content[0].text}`;
    return { result: r.result, info: { ...r.info, ...(saved ? { safety: saved.summary } : {}) } };
  }));

  server.registerTool('command_output', {
    title: 'Get command output',
    description: 'Wait for / read new output of a command started by run_command that was still running.',
    inputSchema: {
      job_id: z.string().describe('job_id returned by run_command'),
      wait_seconds: z.number().int().min(0).optional().describe(`Wait up to this long for it to finish (default/max ${cfg.command_wait_max_sec})`),
      kill: z.boolean().optional().describe('Kill the command instead of waiting'),
      task_id: TaskId,
    }, annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, instrument('command_output', (a) => `${a.job_id}${a.kill ? ' (kill)' : ''}`, async (a) => {
    const job = jobs.jobs.get(a.job_id);
    if (!job) return { result: errText(`unknown job_id ${a.job_id}`) };
    if (a.kill) { jobs.kill(job.id); await jobs.wait(job, 5); }
    const r = await runOrPoll(job, a.kill ? 0 : Math.min(a.wait_seconds ?? cfg.command_wait_max_sec, cfg.command_wait_max_sec));
    return { result: r.result, info: r.info };
  }));

  async function gitRepo(p) {
    const { abs } = paths.resolve(p);
    const r = await run('git', ['-C', abs, 'rev-parse', '--show-toplevel']);
    if (r.code !== 0) throw new Error(`not a git repository: ${abs}`);
    return abs;
  }

  server.registerTool('git_status', {
    title: 'git status',
    description: 'Show branch and working tree status of a git repo inside an allowed root.',
    inputSchema: { repo: z.string().describe('Path inside the repository'), task_id: TaskId }, annotations: ro,
  }, instrument('git_status', (a) => a.repo, async (a) => {
    const repo = await gitRepo(a.repo);
    const r = await run('git', ['-C', repo, 'status', '--short', '--branch']);
    return { result: text(r.out || r.err) };
  }));

  server.registerTool('git_diff', {
    title: 'git diff',
    description: 'Show git diff (working tree vs index by default).',
    inputSchema: {
      repo: z.string().describe('Path inside the repository'),
      staged: z.boolean().optional().describe('Diff of staged changes'),
      ref: z.string().optional().describe('Compare against this ref/range, e.g. HEAD~1 or main...HEAD'),
      path: z.string().optional().describe('Limit to this path'),
      stat: z.boolean().optional().describe('Only --stat summary'),
      task_id: TaskId,
    }, annotations: ro,
  }, instrument('git_diff', (a) => `${a.repo}${a.staged ? ' --staged' : ''}${a.ref ? ' ' + a.ref : ''}${a.path ? ' -- ' + a.path : ''}`, async (a) => {
    const repo = await gitRepo(a.repo);
    if (a.ref && !/^[\w./~^@{}-]+(\.\.\.?[\w./~^@{}-]+)?$/.test(a.ref)) return { result: errText('invalid ref') };
    const args = ['-C', repo, 'diff', '--no-color', '--no-ext-diff'];
    if (a.staged) args.push('--staged');
    if (a.stat) args.push('--stat');
    if (a.ref) args.push(a.ref);
    if (a.path) args.push('--', paths.resolve(a.path).abs);
    const r = await run('git', args);
    return { result: text(clip(r.out || r.err || '(no differences)', cfg.max_output_chars)) };
  }));

  server.registerTool('git_log', {
    title: 'git log',
    description: 'Show recent commits.',
    inputSchema: {
      repo: z.string().describe('Path inside the repository'),
      max_count: z.number().int().min(1).max(200).optional().describe('Default 20'),
      path: z.string().optional().describe('Only commits touching this path'),
      ref: z.string().optional().describe('Branch/ref, default HEAD'),
      task_id: TaskId,
    }, annotations: ro,
  }, instrument('git_log', (a) => `${a.repo} -n ${a.max_count || 20}`, async (a) => {
    const repo = await gitRepo(a.repo);
    if (a.ref && !/^[\w./~^@{}-]+$/.test(a.ref)) return { result: errText('invalid ref') };
    const args = ['-C', repo, 'log', `-n${a.max_count || 20}`, '--date=iso', '--pretty=format:%h %ad %an%d%n    %s'];
    if (a.ref) args.push(a.ref);
    if (a.path) args.push('--', paths.resolve(a.path).abs);
    const r = await run('git', args);
    return { result: text(r.out || r.err || '(no commits)') };
  }));

  // ---- local agents (src/agents.js) ----
  if (ctx.agents) {
    const agents = ctx.agents;
    const lim = () => agents.limits();
    server.registerTool('agent_spawn', {
      title: 'Start a local agent',
      description: `Start an agent that works on its own and returns a result later: a local coding agent in a directory, or another web chat (web-chatgpt / web-gemini) or a gateway model. Backends: ${lim().backends.join(', ')} (default ${lim().default_backend}). ${lim().approval_backends.filter((b) => lim().backends.includes(b)).join('/') || 'none'} need the owner's approval first. At most ${lim().max_running} run at once and ${lim().daily_limit} start per day; each is stopped after timeout_minutes. Returns an agent id at once: then agent_status(wait_sec=40) until it is no longer running, then agent_result. For several agents at once use swarm_start (one call).`,
      inputSchema: {
        prompt: z.string().describe('Complete, self-contained instructions for the agent'),
        cwd: z.string().describe('Working directory inside an allowed root'),
        backend: z.string().optional().describe(`One of: ${lim().backends.join(', ')} (default ${lim().default_backend})`),
        timeout_minutes: z.number().int().min(1).optional().describe(`Stop the agent after this long (default ${agents.c.timeout_min}, max ${agents.c.max_timeout_min})`),
        model: z.string().optional().describe('Model for the backend: a picker label for web-gemini (e.g. "Neon", "Carbon") or web-chatgpt, a model id for gateway/claude/codex'),
        effort: z.string().optional().describe('Thinking level: low|medium|high for web-gemini, a reasoning level label for web-chatgpt'),
        account: z.string().optional().describe('Web backends: account name or "auto"'),
        chat_url: z.string().optional().describe('Web backends: continue this conversation instead of opening a new one'),
        task_id: TaskId,
      }, annotations: rwFor('agent_spawn', { openWorldHint: true }),
    }, instrument('agent_spawn', (a) => `${a.backend || lim().default_backend} agent in ${a.cwd}: ${String(a.prompt || '').slice(0, 120)}`, async (a, c) => {
      const r = await agents.spawn({ backend: a.backend, prompt: a.prompt, cwd: a.cwd, timeout_min: a.timeout_minutes, task_id: c.task.id, call_id: c.call_id, model: a.model, effort: a.effort, account: a.account, chat_url: a.chat_url });
      if (r.error) return { result: errText(`${r.denied ? 'DENIED' : 'ERROR'}: ${r.error}`), denied: !!r.denied, reason: r.error };
      const g = r.agent;
      return { result: text({ agent_id: g.id, backend: g.backend, status: g.status, cwd: g.cwd, timeout_minutes: g.timeout_min, output_dir: g.dir, next: `agent_status(agent_id="${g.id}", wait_sec=40) until status is not "running", then agent_result(agent_id="${g.id}")` }), info: { agent_id: g.id } };
    }));

    const AgentId = z.string().describe('Agent id returned by agent_spawn (ag_xxxxxxxx)');
    server.registerTool('agent_status', {
      title: 'Local agent status',
      description: 'Status of a local agent: running / done / failed / timeout / killed / lost, elapsed time and the tail of its output while running. wait_sec (up to 45) blocks until it finishes or that time passes, which saves tool calls. Pass stop=true to stop it.',
      inputSchema: { agent_id: AgentId, wait_sec: z.number().int().min(0).max(45).optional().describe('Wait up to this many seconds for the agent to finish'), stop: z.boolean().optional().describe('Stop the agent'), task_id: TaskId }, annotations: { ...ro, idempotentHint: false },
    }, instrument('agent_status', (a) => `${a.agent_id}${a.stop ? ' (stop)' : a.wait_sec ? ` (wait ${a.wait_sec}s)` : ''}`, async (a) => {
      const g = agents.get(a.agent_id); if (!g) return { result: errText(`ERROR: no agent ${a.agent_id} (agent_list shows them)`) };
      if (a.stop) agents.stop(g.id);
      else if (a.wait_sec) { const until = Date.now() + Math.min(45, a.wait_sec) * 1000; while (g.status === 'running' && Date.now() < until) { await new Promise((r) => setTimeout(r, 1000)); agents.poll(); } }
      return { result: text(agents.status(g)) };
    }));

    server.registerTool('agent_result', {
      title: 'Local agent result',
      description: 'Final result of a finished local agent: its last message (shortened), exit code, and the paths of the full output files (read them with read_file if you need more).',
      inputSchema: { agent_id: AgentId, task_id: TaskId }, annotations: ro,
    }, instrument('agent_result', (a) => a.agent_id, async (a) => {
      const g = agents.get(a.agent_id); if (!g) return { result: errText(`ERROR: no agent ${a.agent_id} (agent_list shows them)`) };
      if (g.status === 'running') return { result: text({ ...agents.status(g), note: 'still running; call agent_status later' }) };
      return { result: text(agents.summary(g)) };
    }));

    server.registerTool('agent_list', {
      title: 'List local agents',
      description: 'Recent local agents (newest first) with status, plus the running/daily limits.',
      inputSchema: { task_id: TaskId }, annotations: ro,
    }, instrument('agent_list', () => '', async () => ({ result: text({ limits: lim(), agents: agents.list() }) })));
  }

  // ---- swarms (src/swarm.js): one call starts many agents in parallel, the hub schedules them ----
  {
    const sw = () => import('./swarm.js');
    const SwarmId = z.string().describe('Swarm id returned by swarm_start (sw_xxxxxxxx)');
    const Task = z.object({
      id: z.string().optional().describe('Short id, used by depends_on'),
      title: z.string().optional(),
      prompt: z.string().describe('Complete, self-contained instructions for this worker'),
      backend: z.string().optional().describe('Target: web:gemini[:MODEL[:low|medium|high]], web:chatgpt[:MODEL], gateway[:MODEL], claude, codex, or an alias (neon, carbon, ...)'),
      fallback: z.array(z.string()).optional().describe('Targets to rotate to on retries'),
      depends_on: z.array(z.string()).optional().describe('Ids of tasks whose answers this one needs (they are appended to its prompt)'),
      cwd: z.string().optional(), account: z.string().optional(), session: z.string().optional().describe('Named session to continue'),
    });
    server.registerTool('swarm_start', {
      title: 'Start a swarm of agents',
      description: 'Run several sub-tasks in parallel on web chats (ChatGPT/Gemini), gateway models and local agents, with a concurrency cap, retries on fallback targets, dependencies and an optional final synthesis. One call; then swarm_status(wait_sec=40) and swarm_result. Use this instead of many agent_spawn calls.',
      inputSchema: {
        title: z.string().optional(), goal: z.string().optional().describe('The overall goal (each worker sees it)'), cwd: z.string().optional().describe('Default working directory inside an allowed root'),
        tasks: z.array(Task).min(1), concurrency: z.number().int().min(1).max(32).optional(), max_retries: z.number().int().min(0).max(6).optional(),
        synthesize: z.union([z.boolean(), z.object({ backend: z.string().optional(), prompt: z.string().optional() })]).optional().describe('Merge all answers at the end (default true for 2+ tasks)'),
        default_backend: z.string().optional(), task_id: TaskId,
      }, annotations: rwFor('swarm_start', { openWorldHint: true }),
    }, instrument('swarm_start', (a) => `${a.tasks?.length || 0} tasks: ${a.title || a.goal || ''}`.slice(0, 160), async (a, c) => {
      const m = await sw();
      for (const t of a.tasks) if (t.cwd || a.cwd) ctx.paths.resolve(t.cwd || a.cwd); // inside the roots or throws
      const parent = /^swarm:(sw_[0-9a-f]+)/.exec(c.task?.from || '')?.[1];
      const depth = parent ? ((m.loadSwarm(parent)?.depth || 0) + 1) : 0;
      let st;
      try { st = m.createSwarm({ title: a.title, goal: a.goal, cwd: a.cwd, tasks: a.tasks, concurrency: a.concurrency, max_retries: a.max_retries, synthesize: a.synthesize, defaults: a.default_backend ? { backend: a.default_backend } : undefined }, ctx.cfg, { depth, from: c.task?.id || null }); } catch (e) { return { result: errText(`${e.denied ? 'DENIED' : 'ERROR'}: ${e.message}`), denied: !!e.denied, reason: e.message }; }
      m.startRunner(st.id);
      return { result: text({ swarm_id: st.id, tasks: st.tasks.map((t) => ({ id: t.id, backend: t.backend, depends_on: t.depends_on })), next: `swarm_status(swarm_id="${st.id}", wait_sec=40) until status is not "running", then swarm_result(swarm_id="${st.id}")` }), info: { swarm_id: st.id } };
    }));
    server.registerTool('swarm_status', {
      title: 'Swarm status',
      description: 'Progress of a swarm: per sub-task status, backend, attempts, errors. wait_sec (up to 45) blocks until something changes or the swarm ends. Pass cancel=true to stop the whole swarm, retry=[task ids] to run failed ones again.',
      inputSchema: { swarm_id: SwarmId, wait_sec: z.number().int().min(0).max(45).optional(), cancel: z.boolean().optional(), retry: z.array(z.string()).optional(), task_id: TaskId }, annotations: { ...ro, idempotentHint: false },
    }, instrument('swarm_status', (a) => `${a.swarm_id}${a.cancel ? ' (cancel)' : a.retry ? ' (retry)' : ''}`, async (a) => {
      const m = await sw();
      let st = m.loadSwarm(a.swarm_id); if (!st) return { result: errText(`ERROR: no swarm ${a.swarm_id}`) };
      if (a.cancel) m.cancelSwarm(st.id);
      else if (a.retry) { m.retrySwarm(st.id, a.retry); if (!m.swarmSummary(st).runner_alive) m.resumeSwarm(st.id); }
      else if (a.wait_sec) {
        const key = (x) => JSON.stringify([x.status, x.tasks.map((t) => [t.status, t.attempts.length])]);
        const k0 = key(st); const until = Date.now() + Math.min(45, a.wait_sec) * 1000;
        while (Date.now() < until) { await new Promise((r) => setTimeout(r, 1500)); st = m.loadSwarm(st.id); if (key(st) !== k0 || st.status !== 'running') break; }
      }
      return { result: text(m.swarmSummary(m.loadSwarm(a.swarm_id))) };
    }));
    server.registerTool('swarm_result', {
      title: 'Swarm result',
      description: 'Answers of a swarm: each sub-task answer (shortened) and the final synthesis; the full texts are files you can read_file.',
      inputSchema: { swarm_id: SwarmId, chars: z.number().int().min(200).max(20000).optional().describe('Max chars per answer (default 2000)'), task_id: TaskId }, annotations: ro,
    }, instrument('swarm_result', (a) => a.swarm_id, async (a) => {
      const m = await sw();
      const st = m.loadSwarm(a.swarm_id); if (!st) return { result: errText(`ERROR: no swarm ${a.swarm_id}`) };
      return { result: text({ ...m.swarmSummary(st, { answers: true, chars: a.chars || 2000 }), answers_dir: `${m.swarmDir(st.id)}/tasks` }) };
    }));
  }

  server.registerTool('report', {
    title: 'Report result',
    description: 'Send your progress or final answer back to the owner. When the user message has a TASK_ID you MUST finish with report(status="final") containing the complete answer (or status="blocked" with the reason).',
    inputSchema: {
      task_id: z.string().optional().describe('TASK_ID from the user message'),
      status: z.enum(['progress', 'final', 'blocked']).describe('progress = milestone, final = done, blocked = cannot continue'),
      summary: z.string().describe('One or two sentence summary'),
      content: z.string().optional().describe('Full answer / details (markdown ok)'),
      files_changed: z.array(z.string()).optional().describe('Files you changed'),
      tests: z.string().optional().describe('Tests/commands run and their outcome'),
    }, annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, instrument('report', (a) => `[${a.status}] ${a.summary}`, async (a, c) => {
    const rep = { at: new Date().toISOString(), status: a.status, summary: a.summary, content: a.content || '', files_changed: a.files_changed || [], tests: a.tests || '', call_id: c.call_id };
    events.emit('report', { task_id: c.task.id, call_id: c.call_id, ...rep });
    tasks.addReport(c.task, rep);
    return { result: text(`Recorded ${a.status} report for ${c.task.id}.${a.status === 'final' ? ' The owner has received it; you may stop.' : ''}`) };
  }));
}

function safeReal(p) { try { return fs.realpathSync(p); } catch { return p; } }
