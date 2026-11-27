// Terminal renderer for the event stream (`gemweb watch`): a Codex-style,
// colored, live-scrolling timeline. Also used for JSONL replay.
const useColor = (process.stdout.isTTY || process.env.FORCE_COLOR === '1') && !process.env.NO_COLOR;
const c = (code) => (s) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : String(s));
export const col = {
  dim: c('2'), bold: c('1'), red: c('31'), green: c('32'), yellow: c('33'), blue: c('34'), magenta: c('35'), cyan: c('36'), gray: c('90'),
  bgRed: c('41;97'),
};
const TASK_COLORS = [c('36'), c('35'), c('33'), c('34'), c('32'), c('96'), c('95'), c('93')];
const taskColor = new Map();
function tag(id) {
  if (!id) return col.gray('—'.padEnd(10));
  if (!taskColor.has(id)) taskColor.set(id, TASK_COLORS[taskColor.size % TASK_COLORS.length]);
  const short = id.length > 10 ? id.slice(0, 10) : id.padEnd(10);
  return taskColor.get(id)(short);
}
const time = (iso) => col.gray(new Date(iso).toLocaleTimeString('en-GB', { hour12: false }));
const ICON = { list_roots: '◎', list_dir: '▤', read_file: '▸', write_file: '✎', edit_file: '✎', search: '⌕', run_command: '❯', command_output: '❯', git_status: '⎇', git_diff: '⎇', git_log: '⎇', report: '✉' };
const fmtDur = (ms) => (ms == null ? '' : ms < 1000 ? `${ms}ms` : ms < 60000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.floor(ms / 60000)}m${String(Math.round((ms % 60000) / 1000)).padStart(2, '0')}s`);

export class Renderer {
  constructor({ out = process.stdout, showArgs = false, compact = false, maxDiffLines = 80, showAuth = true } = {}) {
    this.out = out; this.showArgs = showArgs; this.compact = compact; this.maxDiffLines = maxDiffLines; this.showAuth = showAuth;
    this.pendingLine = new Map(); // call_id -> partial output line
  }

  w(s) { this.out.write(s + '\n'); }
  gutter(task, lines, color = (x) => x) {
    const pad = ' '.repeat(9) + tag(task) + ' ';
    for (const l of lines) this.w(`${pad}${col.gray('│')} ${color(l)}`);
  }

  event(ev) {
    const T = ev.task_id;
    const head = `${time(ev.ts)} ${tag(T)}`;
    switch (ev.type) {
      case 'tool.start': {
        if (ev.tool === 'report') return; // shown by the report event
        const sum = ev.tool === 'run_command' ? col.cyan(`$ ${ev.args.command}`) + col.gray(`  (cwd ${ev.args.cwd})`) : col.gray(ev.summary || '');
        this.w(`${head} ${col.bold(`${ICON[ev.tool] || '•'} ${ev.tool}`)} ${sum}`);
        if (this.showArgs) this.gutter(T, JSON.stringify(ev.args, null, 2).split('\n'), col.gray);
        return;
      }
      case 'tool.output': {
        if (this.compact) return;
        const prev = this.pendingLine.get(ev.call_id) || '';
        const parts = (prev + ev.chunk).split('\n');
        this.pendingLine.set(ev.call_id, parts.pop());
        if (parts.length) this.gutter(T, parts, ev.stream === 'stderr' ? col.yellow : (x) => x);
        return;
      }
      case 'job.end': {
        const rest = this.pendingLine.get(ev.call_id); if (rest) { this.gutter(T, [rest]); this.pendingLine.delete(ev.call_id); }
        const ok = ev.exit_code === 0;
        this.gutter(T, [`${ok ? col.green('exit 0') : col.red(`exit ${ev.exit_code ?? ev.signal}`)}${ev.timed_out ? col.red(' (timeout)') : ''} ${col.gray('· ' + fmtDur(ev.duration_ms))}`]);
        return;
      }
      case 'tool.end': {
        if (ev.tool === 'report') return;
        if (ev.denied) { this.w(`${head} ${col.bgRed(' DENIED ')} ${col.red(`${ev.tool}: ${ev.reason}`)}`); return; }
        if (!ev.ok) { this.w(`${head} ${col.yellow(`✗ ${ev.tool} error`)} ${col.gray(fmtDur(ev.duration_ms))}`); this.gutter(T, ev.result_preview.split('\n').slice(0, 8), col.yellow); return; }
        if (ev.tool === 'run_command' || ev.tool === 'command_output') { if (ev.running) this.gutter(T, [col.gray(`… still running as ${ev.job_id} (${ev.elapsed_sec}s)`)]); return; }
        if (['write_file', 'edit_file'].includes(ev.tool)) return; // file.changed shows the diff
        if (!this.compact) {
          const lines = ev.result_preview.split('\n');
          const n = ev.tool === 'read_file' ? 1 : 6;
          this.gutter(T, [...lines.slice(0, n), ...(lines.length > n ? [col.gray(`… ${lines.length - n} more lines`)] : [])], col.gray);
        }
        return;
      }
      case 'file.changed': {
        this.gutter(T, [`${col.bold(ev.created ? 'created' : 'modified')} ${ev.path} ${col.green('+' + ev.add)} ${col.red('-' + ev.del)}`]);
        if (this.compact) return;
        const lines = ev.diff.replace(/\n$/, '').split('\n').filter((l) => !/^(Index:|====)/.test(l));
        const shown = lines.slice(2, 2 + this.maxDiffLines);
        this.gutter(T, shown.map((l) => (l.startsWith('@@') ? col.cyan(l) : l.startsWith('+') ? col.green(l) : l.startsWith('-') ? col.red(l) : col.gray(l))));
        if (lines.length - 2 > this.maxDiffLines) this.gutter(T, [col.gray(`… ${lines.length - 2 - this.maxDiffLines} more diff lines (see status page)`)]);
        return;
      }
      case 'confirm.pending':
        this.w(`${head} ${col.yellow('⚠ needs approval')} ${col.bold(ev.command)} ${col.gray(`(${(ev.reasons || []).join(', ')}) — approve: gemweb approve ${ev.confirm_id} · status page`)}`);
        return;
      case 'confirm.resolved': case 'confirm.late':
        this.gutter(T, [ev.approved ? col.green(`approved (${ev.how || ev.by})`) : col.red(`not approved (${ev.how || ev.by})`)]);
        return;
      case 'conflict':
        this.w(`${head} ${col.bgRed(' CONFLICT ')} ${col.red(`${ev.path}: ${ev.message}`)}`);
        return;
      case 'report': {
        const color = ev.status === 'final' ? col.green : ev.status === 'blocked' ? col.yellow : col.blue;
        this.w(`${head} ${color(col.bold(`✉ report [${ev.status}]`))} ${col.bold(ev.summary)}`);
        const body = [...(ev.content ? ev.content.split('\n') : []), ...(ev.tests ? ['', col.gray('tests: ') + ev.tests] : []), ...((ev.files_changed || []).length ? [col.gray('files: ') + ev.files_changed.join(', ')] : [])];
        if (body.length) this.gutter(T, body.slice(0, this.compact ? 6 : 400));
        return;
      }
      case 'task.created': this.w(`${head} ${col.magenta('● task')} ${col.bold(ev.title)} ${col.gray(`from ${ev.from}`)}`); return;
      case 'task.status': this.w(`${head} ${col.magenta('● status')} → ${col.bold(ev.status)}${ev.error ? col.red(' ' + ev.error) : ''}`); return;
      case 'task.queued': this.w(`${head} ${col.gray(`● queued #${ev.position} (${ev.running}/${ev.limit} running)`)}`); return;
      case 'task.slot': this.w(`${head} ${col.gray(`● browser slot ${ev.running}/${ev.limit}`)}`); return;
      case 'driver.log': this.w(`${head} ${col.gray('driver')} ${ev.level === 'error' ? col.red(ev.msg) : ev.level === 'warn' ? col.yellow(ev.msg) : col.gray(ev.msg)}`); return;
      case 'mcp.request': this.w(`${head} ${col.gray(`mcp ${ev.method} from ${ev.client}${ev.client_info ? ` (${ev.client_info.name} ${ev.client_info.version || ''})` : ''}`)}`); return;
      case 'server.start': this.w(`${head} ${col.gray(`server started v${ev.version} pid ${ev.pid}`)}`); return;
      default:
        if (ev.type.startsWith('safety.') || ev.type === 'confirm.auto') { this.w(`${head} ${col.yellow('◆ safety')} ${ev.text || ev.type}`); return; }
        if (ev.type.startsWith('agent.')) { this.w(`${head} ${col.cyan('◆ agent')} ${ev.text || ev.type.slice(6)}`); return; }
        if (ev.type.startsWith('goal.')) this.w(`${head} ${col.magenta(`◎ goal ${ev.goal}`)} ${ev.type === 'goal.stopped' ? col.bold(ev.text || '') : ev.text || ev.type.slice(5)}${ev.round_task ? col.gray(` (${ev.round_task})`) : ''}`);
        else if (ev.type.startsWith('auth.') && this.showAuth) this.w(`${head} ${col.gray(`auth ${ev.type.slice(5)} ${ev.client_name || ev.client_id || ''} ${ev.reason || ''}`)}`);
    }
  }
}
