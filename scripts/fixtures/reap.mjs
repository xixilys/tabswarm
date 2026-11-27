// Test-process hygiene shared by the scripts/*-test.mjs suites.
// - reap(child): kill a spawned server/Chrome when the test exits for any reason (normal end,
//   process.exit, uncaught exception, Ctrl-C, `timeout` SIGTERM), so a crashed run never leaves
//   an orphan holding the fixed test ports for the next run.
// - assertPortsFree(ports): fail fast with a clear message when a fixed test port is already taken
//   (usually by an orphan from an older run) instead of failing later with a confusing error.
import net from 'node:net';

const children = new Set();
let hooked = false;

function killAll() {
  for (const ch of children) {
    try { if (ch.exitCode === null && ch.signalCode === null) ch.kill('SIGTERM'); } catch { /* ignore */ }
  }
  children.clear();
}

export function reap(child) {
  children.add(child);
  child.once?.('exit', () => children.delete(child));
  if (!hooked) {
    hooked = true;
    process.on('exit', killAll);
    for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.once(sig, () => { killAll(); process.exit(128 + 2); });
  }
  return child;
}

// Same as reap() for a process the test did not spawn itself (e.g. a detached Chrome started by
// `webhub browser up`).
export function reapPid(pid) {
  if (!pid) return;
  return reap({ exitCode: null, signalCode: null, kill: (sig) => process.kill(pid, sig) });
}

function portFree(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.listen(port, '127.0.0.1', () => srv.close(() => resolve(true)));
  });
}

export async function assertPortsFree(ports, label = 'test') {
  const busy = [];
  for (const p of ports) if (!(await portFree(p))) busy.push(p);
  if (busy.length) {
    console.error(`${label}: port(s) ${busy.join(', ')} already in use — probably an orphan from an earlier run.\n`
      + `  find it: lsof -nP -iTCP:${busy[0]} -sTCP:LISTEN`);
    process.exit(1);
  }
}
