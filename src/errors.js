// Errors shared by the driver and the site adapters.
export class Blocked extends Error { constructor(kind, detail) { super(`BLOCKED: ${kind}|${detail}`); this.kind = kind; this.detail = detail; } }
export class NeedOperator extends Error { constructor(step, detail) { super(`fast path failed at ${step}: ${detail}`); this.step = step; } }
