// Mock "Gemini" used by `gemweb --driver mock` for offline tests of the whole
// dispatch -> MCP tool calls -> report -> stdout pipeline (queueing, per-task
// isolation, conflicts) without a browser. It follows a tiny script in the task:
//   MOCK write <path>        (content lines until "MOCK end")
//   MOCK edit <path> :: <old text> => <new text>
//   MOCK run <cwd> :: <command>
//   MOCK sleep <seconds>
//   MOCK noreport            do not call report at the end (the page reply is the answer)
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { loadSecrets } from './config.js';

export async function mockGemini({ id, task, cfg }) {
  const secrets = loadSecrets();
  const client = new Client({ name: 'mock-gemini', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${cfg.public_port}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${secrets.static_bearer}` } } }));
  const call = async (name, args) => { const r = await client.callTool({ name, arguments: { ...args, task_id: id } }); return { err: !!r.isError, text: r.content.map((c) => c.text).join('\n') }; };
  const notes = []; const files = []; let failed = false;
  await call('list_roots', {});
  const lines = task.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const m = /^MOCK (\w+)\s*(.*)$/.exec(lines[i].trim());
    if (!m) continue;
    const [, op, rest] = m;
    if (op === 'write') {
      const body = []; while (++i < lines.length && lines[i].trim() !== 'MOCK end') body.push(lines[i]);
      const r = await call('write_file', { path: rest.trim(), content: body.join('\n') + '\n' });
      notes.push(`write ${rest.trim()}: ${r.err ? r.text : 'ok'}`); if (r.err) failed = true; else files.push(rest.trim());
    } else if (op === 'edit') {
      const [p, spec] = rest.split(' :: '); const [o, n] = spec.split(' => ');
      await call('read_file', { path: p.trim() });
      const r = await call('edit_file', { path: p.trim(), edits: [{ old_text: o, new_text: n }] });
      notes.push(`edit ${p.trim()}: ${r.err ? r.text.split('\n')[0] : 'ok'}`); if (r.err) failed = true; else files.push(p.trim());
    } else if (op === 'run') {
      const [cwd, cmd] = rest.split(' :: ');
      const r = await call('run_command', { cwd: cwd.trim(), command: cmd });
      notes.push(`$ ${cmd}\n${r.text.split('\n').slice(1).join('\n').trim()}`); if (r.err || !/exit 0/.test(r.text)) failed = true;
    } else if (op === 'sleep') {
      await new Promise((r) => setTimeout(r, Number(rest) * 1000));
    }
  }
  if (/^MOCK noreport\s*$/m.test(task)) { await client.close(); return { reported: false, notes }; }
  await call('report', { status: failed ? 'blocked' : 'final', summary: failed ? `mock run for ${id} hit an error` : `mock run for ${id} finished`, content: notes.join('\n\n'), files_changed: files, tests: notes.filter((n) => n.startsWith('$')).map((n) => n.split('\n')[0]).join('; ') });
  await client.close();
  return { reported: true, notes };
}
