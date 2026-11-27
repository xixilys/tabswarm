// Target specs: which backend answers a prompt. One string, also usable as a scheduler-style
// "<pool>:<model>[:<effort>]" provider:
//   web:gemini[:MODEL[:EFFORT]]    Gemini web in the hub's browser (MODEL = a picker label such as
//   gemini[:MODEL[:EFFORT]]        "Neon" or "Carbon"; EFFORT = thinking level low|medium|high)
//   web:chatgpt[:MODEL[:EFFORT]]   ChatGPT web (MODEL = picker label or slider level such as "Extra High")
//   gateway[:MODEL[:EFFORT]]       an HTTP model gateway (Anthropic- or OpenAI-compatible, see gateway.js)
//   gateway@NAME:MODEL             a named gateway from config.gateways
//   agent:BACKEND[:MODEL[:EFFORT]] a local agent backend from config.agents.commands (claude, codex, ...)
//   BACKEND[:MODEL]                the same, when BACKEND is a configured agent backend
//   ALIAS                          config.models[ALIAS] (built in: neon, carbon, hydrogen -> Gemini web)
import { agentCfg } from './agents.js';

export const BUILTIN_ALIASES = {
  gpt: 'web:chatgpt',
  neon: 'web:gemini:Neon',
  carbon: 'web:gemini:Carbon',
  hydrogen: 'web:gemini:Hydrogen',
};

export function aliases(cfg) { return { ...BUILTIN_ALIASES, ...(cfg.models || {}) }; }

function resolveAlias(spec, cfg, depth = 0) {
  const al = aliases(cfg);
  const s = String(spec || '').trim();
  if (depth > 5) return s;
  const low = s.toLowerCase();
  if (al[low] && al[low] !== s) return resolveAlias(al[low], cfg, depth + 1);
  const [head, ...rest] = s.split(':');
  const h = head.toLowerCase();
  if (rest.length && al[h] && !['web', 'gateway', 'agent', 'gemini', 'chatgpt'].includes(h)) {
    // "neon:high" = alias + extra effort segment
    const base = parseTarget(al[h], cfg, depth + 1);
    return { ...base, effort: rest[rest.length - 1] || base.effort };
  }
  return s;
}

// Returns { kind: 'web'|'gateway'|'agent', site?, gateway?, backend?, model, effort, spec }.
export function parseTarget(spec, cfg, depth = 0) {
  const r = resolveAlias(spec || cfg.default_target || 'web:gemini', cfg, depth);
  if (typeof r === 'object') return r;
  const parts = r.split(':').map((x) => x.trim());
  let [head, ...rest] = parts;
  head = head.toLowerCase();
  if (head === 'web') { head = (rest.shift() || 'gemini').toLowerCase(); }
  if (head === 'gemini' || head === 'chatgpt') {
    return { kind: 'web', site: head, model: rest[0] || null, effort: rest[1] || null, spec: r };
  }
  if (head === 'gateway' || head === 'gw' || head.startsWith('gateway@') || head.startsWith('gw@')) {
    const name = head.includes('@') ? head.split('@')[1] : null;
    return { kind: 'gateway', gateway: name, model: rest[0] || null, effort: rest[1] || null, spec: r };
  }
  if (head === 'agent') head = (rest.shift() || '').toLowerCase();
  const ac = agentCfg(cfg);
  if (head && ac.commands[head]) return { kind: 'agent', backend: head, model: rest[0] || null, effort: rest[1] || null, spec: r };
  throw Object.assign(new Error(`unknown target "${spec}": use web:gemini[:MODEL[:EFFORT]], web:chatgpt[:MODEL], gateway:MODEL, a local agent backend (${Object.keys(ac.commands).join(', ')}) or an alias (${Object.keys(aliases(cfg)).join(', ')})`), { usage: true });
}

// Spec + --model/--effort overrides.
export function targetFrom({ backend, model, effort, site }, cfg) {
  const t = parseTarget(backend || (site ? `web:${site}` : null), cfg);
  return { ...t, model: model || t.model || null, effort: effort || t.effort || null };
}

export function targetLabel(t) {
  const base = t.kind === 'web' ? `web:${t.site}` : t.kind === 'gateway' ? `gateway${t.gateway ? '@' + t.gateway : ''}` : t.backend;
  return [base, t.model, t.effort].filter(Boolean).join(':');
}
