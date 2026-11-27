// Minimal OAuth 2.1 authorization server for the MCP endpoint:
//   RFC 9728 protected-resource metadata, RFC 8414 AS metadata, RFC 7591 dynamic
//   client registration, authorization code + PKCE (S256), refresh tokens.
// The consent page asks for the owner's passcode; nothing is granted without it.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { STATE_DIR, safeEqual, sha256 } from './config.js';

const STORE = path.join(STATE_DIR, 'oauth.json');
const b64url = (buf) => Buffer.from(buf).toString('base64url');
const rand = (n = 32) => b64url(crypto.randomBytes(n));
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// A token's resource (RFC 8707) must be this server: base or base/mcp, trailing slash ignored.
// Tokens without one (clients that send no resource parameter) are accepted.
export function resourceMatches(resource, base) {
  if (!resource || !base) return true;
  const n = (x) => String(x).replace(/\/+$/, '');
  return [n(base), n(base) + '/mcp'].includes(n(resource));
}

export class OAuth {
  constructor(cfg, secrets, events) {
    this.cfg = cfg; this.secrets = secrets; this.events = events;
    this.codes = new Map(); this.fails = []; // passcode failures (timestamps)
    this.db = { clients: {}, tokens: {} };
    if (fs.existsSync(STORE)) { try { this.db = JSON.parse(fs.readFileSync(STORE, 'utf8')); } catch { /* reset */ } }
    // Manual client (for Gemini's "Advanced features" credential fields).
    this.db.clients[secrets.manual_client_id] = {
      client_id: secrets.manual_client_id, client_secret_hash: sha256(secrets.manual_client_secret), client_name: 'manual (configured)',
      redirect_uris: [], token_endpoint_auth_method: 'client_secret_post', manual: true, created: this.db.clients[secrets.manual_client_id]?.created || new Date().toISOString(),
    };
    this._save();
  }

  _save() { fs.writeFileSync(STORE, JSON.stringify(this.db, null, 2), { mode: 0o600 }); }

  metadata(base) {
    return {
      issuer: base,
      authorization_endpoint: `${base}/authorize`,
      token_endpoint: `${base}/token`,
      registration_endpoint: `${base}/register`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['client_secret_post', 'client_secret_basic', 'none'],
      scopes_supported: ['mcp'],
      service_documentation: `${base}/`,
      // RFC 9207: every authorization response carries iss (ChatGPT then uses its stable redirect URI)
      authorization_response_iss_parameter_supported: true,
    };
  }

  resourceMetadata(base) {
    return { resource: `${base}/mcp`, authorization_servers: [base], scopes_supported: ['mcp'], bearer_methods_supported: ['header'], resource_name: 'Local Projects MCP' };
  }

  redirectAllowed(uri, client) {
    let u; try { u = new URL(uri); } catch { return false; }
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
    if (u.protocol !== 'https:' && !(u.protocol === 'http:' && local)) return false;
    if (client && !client.manual && client.redirect_uris.length && !client.redirect_uris.includes(uri)) return false;
    const suffixes = this.cfg.oauth.redirect_host_suffixes || [];
    if (!suffixes.length) return true;
    return suffixes.some((s) => u.hostname === s || u.hostname.endsWith('.' + s));
  }

  register(body) {
    const n = Object.values(this.db.clients).filter((c) => !c.manual).length;
    if (n >= this.cfg.oauth.max_clients) {
      // Drop the oldest registration that never obtained a token.
      const stale = Object.values(this.db.clients).filter((c) => !c.manual && !c.last_token).sort((a, b) => a.created.localeCompare(b.created))[0];
      if (!stale) return { status: 400, body: { error: 'invalid_client_metadata', error_description: 'too many clients' } };
      delete this.db.clients[stale.client_id];
    }
    const redirect_uris = Array.isArray(body.redirect_uris) ? body.redirect_uris.map(String) : [];
    if (!redirect_uris.length) return { status: 400, body: { error: 'invalid_redirect_uri', error_description: 'redirect_uris required' } };
    for (const r of redirect_uris) {
      if (!this.redirectAllowed(r, null)) {
        this.events.emit('auth.rejected', { stage: 'register', reason: 'redirect_uri not allowed', redirect_uri: r, client_name: body.client_name });
        return { status: 400, body: { error: 'invalid_redirect_uri', error_description: `redirect_uri not allowed: ${r}` } };
      }
    }
    const method = ['none', 'client_secret_post', 'client_secret_basic'].includes(body.token_endpoint_auth_method) ? body.token_endpoint_auth_method : 'client_secret_basic';
    const client_id = 'gwmc-' + rand(12);
    const client_secret = method === 'none' ? undefined : rand(32);
    const c = {
      client_id, client_secret_hash: client_secret ? sha256(client_secret) : null, client_name: String(body.client_name || 'unnamed').slice(0, 100),
      redirect_uris, token_endpoint_auth_method: method, created: new Date().toISOString(),
    };
    this.db.clients[client_id] = c; this._save();
    this.events.emit('auth.client_registered', { client_id, client_name: c.client_name, redirect_uris, method });
    return {
      status: 201,
      body: {
        client_id, ...(client_secret ? { client_secret, client_secret_expires_at: 0 } : {}), client_id_issued_at: Math.floor(Date.now() / 1000),
        client_name: c.client_name, redirect_uris, token_endpoint_auth_method: method, grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'],
      },
    };
  }

  // Validates an /authorize request; returns { client, params } or { error }.
  checkAuthorize(q) {
    const client = this.db.clients[q.client_id];
    if (!client) return { error: `unknown client_id ${q.client_id || ''}` };
    if (q.response_type !== 'code') return { error: 'response_type must be code' };
    if (!q.redirect_uri || !this.redirectAllowed(q.redirect_uri, client)) {
      this.events.emit('auth.rejected', { stage: 'authorize', reason: 'redirect_uri not allowed', redirect_uri: q.redirect_uri, client_id: q.client_id });
      return { error: `redirect_uri not allowed: ${q.redirect_uri || '(missing)'}` };
    }
    if (q.code_challenge && q.code_challenge_method && q.code_challenge_method !== 'S256') return { error: 'only S256 PKCE is supported' };
    if (!q.code_challenge && client.token_endpoint_auth_method === 'none') return { error: 'PKCE code_challenge required for public clients' };
    return { client };
  }

  consentPage(q, client, err = '') {
    const host = (() => { try { return new URL(q.redirect_uri).host; } catch { return '?'; } })();
    const hidden = ['client_id', 'redirect_uri', 'state', 'code_challenge', 'code_challenge_method', 'scope', 'response_type', 'resource']
      .map((k) => (q[k] ? `<input type="hidden" name="${k}" value="${esc(q[k])}">` : '')).join('');
    return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Authorize Local Projects MCP</title><style>
:root{color-scheme:light dark;--bg:#0f1115;--fg:#e6e6e6;--mut:#9aa0a6;--card:#171a21;--acc:#7aa2f7;--bad:#f7768e}
@media (prefers-color-scheme: light){:root{--bg:#f6f7f9;--fg:#1d1f23;--mut:#5f6368;--card:#fff;--acc:#2856d6;--bad:#c62828}}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 -apple-system,system-ui,sans-serif;display:flex;min-height:100vh;align-items:center;justify-content:center;padding:16px;box-sizing:border-box}
.card{background:var(--card);border-radius:14px;padding:24px;max-width:420px;width:100%;box-shadow:0 4px 24px #0003}
h1{font-size:19px;margin:0 0 8px}p{color:var(--mut);margin:6px 0}code{font-size:13px}
input[type=password]{width:100%;box-sizing:border-box;padding:11px;border-radius:9px;border:1px solid #8885;background:transparent;color:var(--fg);font-size:16px;margin:14px 0}
button{width:100%;padding:11px;border:0;border-radius:9px;background:var(--acc);color:#fff;font-size:16px;cursor:pointer}.err{color:var(--bad)}
</style></head><body><form class="card" method="post" action="authorize">
<h1>Allow access to your local projects?</h1>
<p><b>${esc(client.client_name)}</b> wants to read/write files and run commands in the allowed project folders on this Mac.</p>
<p>Returns to: <code>${esc(host)}</code></p>
${err ? `<p class="err">${esc(err)}</p>` : ''}
${hidden}<input type="password" name="passcode" placeholder="Passcode" autocomplete="current-password" autofocus required>
<button type="submit">Allow</button></form></body></html>`;
  }

  // Returns { redirect } on success or { page } to re-render.
  approve(form) {
    const chk = this.checkAuthorize(form);
    if (chk.error) return { error: chk.error };
    const now = Date.now();
    this.fails = this.fails.filter((t) => now - t < 15 * 60 * 1000);
    if (this.fails.length >= 8) return { page: this.consentPage(form, chk.client, 'Too many wrong attempts. Try again in 15 minutes.') };
    if (!safeEqual(form.passcode, this.secrets.passcode)) {
      this.fails.push(now);
      this.events.emit('auth.rejected', { stage: 'consent', reason: 'wrong passcode', client_id: form.client_id });
      return { page: this.consentPage(form, chk.client, 'Wrong passcode.') };
    }
    const code = rand(24);
    this.codes.set(code, {
      client_id: form.client_id, redirect_uri: form.redirect_uri, code_challenge: form.code_challenge || null, scope: form.scope || 'mcp',
      resource: form.resource || null, expires: now + 10 * 60 * 1000,
    });
    this.events.emit('auth.authorized', { client_id: form.client_id, client_name: chk.client.client_name, redirect_host: new URL(form.redirect_uri).host });
    const u = new URL(form.redirect_uri);
    u.searchParams.set('code', code);
    if (form.iss_base) u.searchParams.set('iss', form.iss_base);
    if (form.state) u.searchParams.set('state', form.state);
    return { redirect: u.toString() };
  }

  _clientAuth(req, body) {
    let id = body.client_id, secret = body.client_secret;
    const h = req.headers.authorization || '';
    if (h.startsWith('Basic ')) {
      const [a, b] = Buffer.from(h.slice(6), 'base64').toString().split(':');
      id = decodeURIComponent(a || ''); secret = decodeURIComponent(b || '');
    }
    const c = this.db.clients[id];
    if (!c) return null;
    if (c.client_secret_hash) { if (!secret || !safeEqual(sha256(secret), c.client_secret_hash)) return null; }
    return c;
  }

  _issue(client, scope, resource) {
    const access = rand(32), refresh = rand(32), now = Date.now();
    const o = this.cfg.oauth;
    this.db.tokens[sha256(access)] = { kind: 'access', client_id: client.client_id, scope, resource, expires: now + o.access_token_ttl_sec * 1000 };
    this.db.tokens[sha256(refresh)] = { kind: 'refresh', client_id: client.client_id, scope, resource, expires: now + o.refresh_token_ttl_sec * 1000 };
    client.last_token = new Date().toISOString();
    for (const [k, t] of Object.entries(this.db.tokens)) if (t.expires < now) delete this.db.tokens[k];
    this._save();
    this.events.emit('auth.token_issued', { client_id: client.client_id, client_name: client.client_name });
    return { access_token: access, token_type: 'Bearer', expires_in: o.access_token_ttl_sec, refresh_token: refresh, scope };
  }

  token(req, body) {
    const client = this._clientAuth(req, body);
    if (!client) return { status: 401, body: { error: 'invalid_client' } };
    if (body.grant_type === 'authorization_code') {
      const c = this.codes.get(body.code);
      this.codes.delete(body.code);
      if (!c || c.expires < Date.now() || c.client_id !== client.client_id) return { status: 400, body: { error: 'invalid_grant' } };
      if (body.redirect_uri && body.redirect_uri !== c.redirect_uri) return { status: 400, body: { error: 'invalid_grant', error_description: 'redirect_uri mismatch' } };
      if (c.code_challenge) {
        if (!body.code_verifier || b64url(crypto.createHash('sha256').update(body.code_verifier).digest()) !== c.code_challenge) {
          return { status: 400, body: { error: 'invalid_grant', error_description: 'PKCE verification failed' } };
        }
      }
      return { status: 200, body: this._issue(client, c.scope, c.resource) };
    }
    if (body.grant_type === 'refresh_token') {
      const h = sha256(String(body.refresh_token || ''));
      const t = this.db.tokens[h];
      if (!t || t.kind !== 'refresh' || t.expires < Date.now() || t.client_id !== client.client_id) return { status: 400, body: { error: 'invalid_grant' } };
      delete this.db.tokens[h];
      return { status: 200, body: this._issue(client, t.scope, t.resource) };
    }
    return { status: 400, body: { error: 'unsupported_grant_type' } };
  }

  // Bearer check for /mcp. Returns { client_id, client_name } or null.
  verify(req, base) {
    const h = req.headers.authorization || '';
    if (!h.startsWith('Bearer ')) return null;
    const tok = h.slice(7).trim();
    if (safeEqual(tok, this.secrets.static_bearer)) return { client_id: 'static-bearer', client_name: 'static token' };
    const t = this.db.tokens[sha256(tok)];
    if (!t || t.kind !== 'access' || t.expires < Date.now()) return null;
    if (!resourceMatches(t.resource, base)) return null; // token issued for another resource (audience)
    const c = this.db.clients[t.client_id];
    if (!c) return null;
    return { client_id: c.client_id, client_name: c.client_name };
  }

  summary() {
    const now = Date.now();
    const live = Object.values(this.db.tokens).filter((t) => t.kind === 'access' && t.expires > now);
    return Object.values(this.db.clients).map((c) => ({ client_id: c.client_id, client_name: c.client_name, manual: !!c.manual, created: c.created, last_token: c.last_token || null, live_tokens: live.filter((t) => t.client_id === c.client_id).length }));
  }
}
