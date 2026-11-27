// Model gateway backend: one HTTP call per turn to an Anthropic-compatible (/v1/messages) or
// OpenAI-compatible (/v1/chat/completions) endpoint. Use it for planning, design and review with
// models that have no web UI here, or that you reach through a local gateway/proxy.
//
// config.json:
//   "gateways": { "default": { "type": "anthropic", "base_url": "http://127.0.0.1:4000",
//                              "api_key_env": "MY_GATEWAY_KEY", "max_tokens": 8192,
//                              "effort_param": "reasoning_effort" } }
// or the environment: TABSWARM_GATEWAY_URL, TABSWARM_GATEWAY_KEY, TABSWARM_GATEWAY_TYPE
// (anthropic|openai, default anthropic), TABSWARM_GATEWAY_MODEL.
// The key is read from the environment (api_key_env) or the gateway's api_key; it is never logged.

export function gatewayCfg(cfg, name) {
  const all = cfg.gateways || {};
  const g = { ...(all[name || 'default'] || (name ? null : Object.values(all)[0]) || {}) };
  if (name && !all[name]) throw Object.assign(new Error(`no gateway "${name}" in config.gateways (have: ${Object.keys(all).join(', ') || 'none'})`), { usage: true });
  const env = process.env;
  g.type = (g.type || env.TABSWARM_GATEWAY_TYPE || 'anthropic').toLowerCase();
  g.base_url = String(g.base_url || env.TABSWARM_GATEWAY_URL || '').replace(/\/+$/, '');
  g.key = g.api_key || (g.api_key_env ? env[g.api_key_env] : '') || env.TABSWARM_GATEWAY_KEY || '';
  g.default_model = g.default_model || env.TABSWARM_GATEWAY_MODEL || '';
  g.max_tokens = Number(g.max_tokens) || 8192;
  if (!g.base_url) throw Object.assign(new Error('no model gateway configured: set config.gateways.default.base_url or TABSWARM_GATEWAY_URL'), { usage: true });
  if (!['anthropic', 'openai'].includes(g.type)) throw Object.assign(new Error(`gateway type must be anthropic or openai, not "${g.type}"`), { usage: true });
  return g;
}

// messages: [{role:'user'|'assistant', content:string}]. Returns { text, usage, model }.
export async function gatewayChat({ cfg, gateway, model, effort, messages, system, timeoutSec = 900, fetchImpl = fetch }) {
  const g = gatewayCfg(cfg, gateway);
  const m = model || g.default_model;
  if (!m) throw Object.assign(new Error('no gateway model given (--model, or gateways.<name>.default_model)'), { usage: true });
  const signal = AbortSignal.timeout(timeoutSec * 1000);
  let url, body, headers = { 'content-type': 'application/json' };
  if (g.type === 'anthropic') {
    url = `${g.base_url}/v1/messages`;
    body = { model: m, max_tokens: g.max_tokens, messages, ...(system ? { system } : {}) };
    if (g.key) { headers['x-api-key'] = g.key; headers.authorization = `Bearer ${g.key}`; }
    headers['anthropic-version'] = '2023-06-01';
  } else {
    url = `${g.base_url}/v1/chat/completions`;
    body = { model: m, messages: system ? [{ role: 'system', content: system }, ...messages] : messages };
    if (g.key) headers.authorization = `Bearer ${g.key}`;
  }
  if (effort && g.effort_param) body[g.effort_param] = effort;
  const r = await fetchImpl(url, { method: 'POST', headers, body: JSON.stringify(body), signal });
  const raw = await r.text();
  let j; try { j = JSON.parse(raw); } catch { j = null; }
  if (!r.ok) throw Object.assign(new Error(`gateway ${r.status}: ${(j?.error?.message || j?.error || raw || r.statusText).toString().slice(0, 400)}`), { status: r.status, retryable: r.status === 429 || r.status >= 500 });
  let text = '';
  if (g.type === 'anthropic') text = (j?.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('');
  else text = j?.choices?.[0]?.message?.content || '';
  return { text: String(text).trim(), usage: j?.usage || null, model: j?.model || m };
}
