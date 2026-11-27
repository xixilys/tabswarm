#!/usr/bin/env node
// Walks the OAuth flow Gemini uses (discovery -> dynamic registration -> consent with
// passcode -> code + PKCE -> token -> refresh) against a base URL, then calls a tool; then the
// ChatGPT variant (public client, chatgpt.com redirect, RFC 9207 iss, RFC 8707 resource).
//   node scripts/oauth-check.mjs https://xxx.trycloudflare.com
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const base = (process.argv[2] || 'http://127.0.0.1:8781').replace(/\/$/, '');
const STATE = process.env.GWM_STATE_DIR || path.join(os.homedir(), '.gemini-web-mcp');
const secrets = JSON.parse(fs.readFileSync(path.join(STATE, 'secrets.json'), 'utf8'));
let ok = true;
const check = (n, c, d = '') => { console.log(`${c ? '✓' : '✗'} ${n}${c ? '' : ' ' + d}`); if (!c) ok = false; };

const r401 = await fetch(`${base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
const wa = r401.headers.get('www-authenticate') || '';
check('401 + resource_metadata', r401.status === 401 && wa.includes('resource_metadata'), wa);
const prm = await (await fetch(wa.match(/resource_metadata="([^"]+)"/)[1])).json();
const asm = await (await fetch(`${prm.authorization_servers[0]}/.well-known/oauth-authorization-server`)).json();
check('AS metadata has DCR + S256', !!asm.registration_endpoint && asm.code_challenge_methods_supported.includes('S256'));

const redirect = 'https://localhost/oauth/callback';
const reg = await (await fetch(asm.registration_endpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ client_name: 'oauth-check', redirect_uris: [redirect], token_endpoint_auth_method: 'client_secret_post' }) })).json();
check('dynamic registration', !!reg.client_id && !!reg.client_secret, JSON.stringify(reg));
const badReg = await fetch(asm.registration_endpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ client_name: 'evil', redirect_uris: ['https://evil.example.com/cb'] }) });
check('registration with foreign redirect host refused', badReg.status === 400);

const verifier = crypto.randomBytes(32).toString('base64url');
const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
const q = { response_type: 'code', client_id: reg.client_id, redirect_uri: redirect, state: 'st123', code_challenge: challenge, code_challenge_method: 'S256', scope: 'mcp' };
const page = await fetch(`${asm.authorization_endpoint}?${new URLSearchParams(q)}`);
check('consent page asks for passcode', page.status === 200 && (await page.text()).includes('Passcode'));
const wrong = await fetch(asm.authorization_endpoint, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ ...q, passcode: 'wrong' }) });
check('wrong passcode -> no code', wrong.status === 200 && (await wrong.text()).includes('Wrong passcode'));
const good = await fetch(asm.authorization_endpoint, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ ...q, passcode: secrets.passcode }) });
const loc = new URL(good.headers.get('location') || 'http://x/');
check('passcode -> redirect with code + state', good.status === 302 && loc.searchParams.get('code') && loc.searchParams.get('state') === 'st123', good.status);

const tokReq = (extra) => fetch(asm.token_endpoint, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_id: reg.client_id, client_secret: reg.client_secret, ...extra }) });
const badPkce = await tokReq({ grant_type: 'authorization_code', code: loc.searchParams.get('code'), redirect_uri: redirect, code_verifier: 'nope' });
check('bad PKCE verifier refused (code burned)', badPkce.status === 400);
// fresh code for the real exchange
const good2 = await fetch(asm.authorization_endpoint, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ ...q, passcode: secrets.passcode }) });
const code2 = new URL(good2.headers.get('location')).searchParams.get('code');
const tok = await (await tokReq({ grant_type: 'authorization_code', code: code2, redirect_uri: redirect, code_verifier: verifier })).json();
check('token exchange', !!tok.access_token && !!tok.refresh_token, JSON.stringify(tok));
const ref = await (await tokReq({ grant_type: 'refresh_token', refresh_token: tok.refresh_token })).json();
check('refresh token rotation', !!ref.access_token && ref.access_token !== tok.access_token);

const client = new Client({ name: 'oauth-check', version: '1' });
await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${ref.access_token}` } } }));
const tools = await client.listTools();
check(`tools/list via OAuth token (${tools.tools.length} tools)`, tools.tools.length >= 12);
const roots = await client.callTool({ name: 'list_roots', arguments: { task_id: 'oauth_check' } });
check('tool call via OAuth token', !roots.isError);
await client.close();

// ChatGPT custom MCP server: DCR as a public client, resource = the MCP URL, iss in the redirect.
check('AS metadata announces iss in authorization responses (RFC 9207)', asm.authorization_response_iss_parameter_supported === true);
const cgRedirect = 'https://chatgpt.com/connector_platform_oauth_redirect';
const cg = await (await fetch(asm.registration_endpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ client_name: 'ChatGPT', redirect_uris: [cgRedirect, 'https://chatgpt.com/connector/oauth/abc123'], token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'] }) })).json();
check('ChatGPT registration (public client, chatgpt.com redirects)', !!cg.client_id && !cg.client_secret && cg.token_endpoint_auth_method === 'none', JSON.stringify(cg));
const cgFlow = async (resource) => {
  const v = crypto.randomBytes(32).toString('base64url');
  const cq = { response_type: 'code', client_id: cg.client_id, redirect_uri: cgRedirect, state: 'cg1', code_challenge: crypto.createHash('sha256').update(v).digest('base64url'), code_challenge_method: 'S256', scope: 'mcp', resource };
  const g = await fetch(asm.authorization_endpoint, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ ...cq, passcode: secrets.passcode }) });
  const l = new URL(g.headers.get('location') || 'http://x/');
  const t = await (await fetch(asm.token_endpoint, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_id: cg.client_id, grant_type: 'authorization_code', code: l.searchParams.get('code') || '', redirect_uri: cgRedirect, code_verifier: v, resource }) })).json();
  return { loc: l, tok: t };
};
const cg1 = await cgFlow(prm.resource);
check('redirect to chatgpt.com carries code, state and iss = issuer', cg1.loc.host === 'chatgpt.com' && !!cg1.loc.searchParams.get('code') && cg1.loc.searchParams.get('state') === 'cg1' && cg1.loc.searchParams.get('iss') === asm.issuer, cg1.loc.toString());
check('public client gets a token with PKCE only', !!cg1.tok.access_token, JSON.stringify(cg1.tok));
const mcpInit = (tokn) => fetch(`${base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${tokn}` }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'cg', version: '1' } } }) });
check('token for this server\'s resource works on /mcp', (await mcpInit(cg1.tok.access_token)).status === 200);
const cg2 = await cgFlow('https://other.example.com/mcp');
check('token issued for another resource is refused on /mcp (401)', !!cg2.tok.access_token && (await mcpInit(cg2.tok.access_token)).status === 401, JSON.stringify(cg2.tok));
console.log(ok ? 'OAuth flow OK' : 'OAuth flow FAILED');
process.exit(ok ? 0 : 1);
