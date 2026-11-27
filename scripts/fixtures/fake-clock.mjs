// Pins the clock of a test (and, through NODE_OPTIONS, of every Node process it starts) to a fixed local day,
// so a run that happens to cross midnight cannot change what "today" means mid-test (daily-quota checks).
// The clock keeps ticking normally; only its starting point is moved: apparent time = real time - delta, where
// delta is shared by every process (WEBHUB_TEST_CLOCK_DELTA_MS), so all processes agree with each other.
// Usage: `import './fixtures/fake-clock.mjs'` as the FIRST import of a test script.
import { fileURLToPath } from 'node:url';

const RealDate = Date;
if (process.env.WEBHUB_TEST_CLOCK_DELTA_MS === undefined) {
  const fakeStart = new RealDate(2026, 2, 10, 10, 0, 0).getTime(); // 2026-03-10 10:00 local: ~14 h before the next midnight
  process.env.WEBHUB_TEST_CLOCK_DELTA_MS = String(RealDate.now() - fakeStart);
}
const delta = Number(process.env.WEBHUB_TEST_CLOCK_DELTA_MS);
if (!globalThis.__webhubFakeClock) {
  globalThis.__webhubFakeClock = true;
  class FakeDate extends RealDate {
    constructor(...a) { if (a.length === 0) super(RealDate.now() - delta); else super(...a); }
    static now() { return RealDate.now() - delta; }
  }
  globalThis.Date = FakeDate;
}
// children of this process load the same shim first
const me = fileURLToPath(import.meta.url);
const opt = `--import=${me}`;
if (!(process.env.NODE_OPTIONS || '').includes(opt)) process.env.NODE_OPTIONS = `${process.env.NODE_OPTIONS || ''} ${opt}`.trim();
