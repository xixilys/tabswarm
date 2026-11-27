// Configuration and secrets. Everything mutable lives in STATE_DIR, never in the git checkout:
// $WEBHUB_STATE_DIR, else the legacy ~/.gemini-web-mcp when it exists, else ~/.tabswarm.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

export const HOME = os.homedir();
export const STATE_DIR = process.env.WEBHUB_STATE_DIR || process.env.GWM_STATE_DIR
  || (fs.existsSync(path.join(HOME, '.gemini-web-mcp')) ? path.join(HOME, '.gemini-web-mcp') : path.join(HOME, '.tabswarm'));
// launchd label prefix (same rule as bin/gwmcp)
export const LAUNCHD_PREFIX = process.env.WEBHUB_LAUNCHD_PREFIX
  || (() => { try { return fs.readFileSync(path.join(STATE_DIR, 'launchd_prefix'), 'utf8').trim(); } catch { return ''; } })()
  || 'io.github.tabswarm.hub';
export const CONFIG_PATH = path.join(STATE_DIR, 'config.json');
export const SECRETS_PATH = path.join(STATE_DIR, 'secrets.json');

export function expandHome(p) {
  if (typeof p !== 'string') return p;
  if (p === '~') return HOME;
  if (p.startsWith('~/')) return path.join(HOME, p.slice(2));
  return p;
}

export const DEFAULT_CONFIG = {
  // Public listener: /mcp + OAuth + read-only remote view. Exposed through the tunnel.
  public_host: '127.0.0.1',
  public_port: 8781,
  // Fixed public base URL (e.g. https://hub.example.com). Empty = derive from Host header.
  public_base_url: '',
  // Hosts accepted on the public listener (besides localhost). Suffix match.
  public_host_suffixes: ['.trycloudflare.com'],
  // Local admin/status listener. Keep on 127.0.0.1 (or a LAN address you trust).
  admin_host: '127.0.0.1',
  admin_port: 8782,

  // Folders the web models may read and write (through the MCP tools) and local agents may work in.
  // Set your own in config.json; nothing outside them is reachable.
  roots: [
    { name: 'projects', path: '~/projects' },
  ],
  // Paths inside roots that are never readable/writable (glob, matched on the path relative to the root and the basename).
  deny_globs: ['**/.env', '**/.env.*', '**/*.pem', '**/*.key', '**/id_rsa*', '**/id_ed25519*', '**/.ssh/**',
    '**/.git/config', '**/secrets.json', '**/credentials*.json', '**/.netrc', '**/.npmrc', '**/*signing_key*'],

  // Risky commands (src/policy.js CONFIRM list): "auto" = run without asking after a git snapshot /
  // trash copy (src/safety.js) and log it; "confirm" = wait for approval
  // on the local status page; "deny" = always refuse. The HARD_DENY list is refused in every mode.
  dangerous_policy: 'auto',
  // Change only the MCP destructiveHint sent to web clients (Google/ChatGPT);
  // server-side path policy, command policy, safety snapshots/trash, and sandbox-exec still apply.
  web_write_no_prompt: true,
  gemini_run_command_no_prompt: true,
  safety: { keep_days: 7, trash_max_mb: 500 },   // trash: ~/.gemini-web-mcp/trash/<date>/
  confirm_wait_sec: 45,          // how long one tool call blocks waiting for approval (MCP clients often time out at 60s)
  approval_ttl_sec: 900,         // a late approval stays valid this long so Gemini can retry the same command
  sandbox: true,                 // run commands under macOS sandbox-exec (writes only inside roots + temp/caches)
  sandbox_extra_write: ['~/.cache', '~/Library/Caches', '~/.npm', '~/.bun', '~/.cargo/registry', '~/.local/share/uv', '~/.pnpm-store'],
  sandbox_deny_read: ['~/.ssh', '~/.cloudflared', '~/.gemini-web-mcp', '~/.tabswarm', '~/.web-ai-hub', '~/.aws', '~/.gnupg', '~/.config/gh',
    '~/Library/Keychains', '~/Library/Application Support/Google/Chrome', '~/.codex/auth.json', '~/.claude/.credentials.json'],
  command_path: '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin',
  command_wait_max_sec: 45,      // max time one run_command/command_output call blocks; longer jobs continue in the background
  command_timeout_default_sec: 600,
  command_timeout_max_sec: 3600,
  max_read_bytes: 400000,
  max_output_chars: 60000,

  oauth: {
    access_token_ttl_sec: 30 * 24 * 3600,
    refresh_token_ttl_sec: 180 * 24 * 3600,
    // Redirect URIs accepted at /authorize (host suffix match). Empty list = accept any https redirect.
    // Google (Gemini custom apps) and OpenAI (ChatGPT custom MCP servers: chatgpt.com/connector_platform_oauth_redirect,
    // chatgpt.com/connector/oauth/<id>, platform.openai.com/apps-manage/oauth).
    redirect_host_suffixes: ['google.com', 'googleusercontent.com', 'googleapis.com', 'chatgpt.com', 'openai.com', 'localhost', '127.0.0.1'],
    max_clients: 50,
  },

  // Remote read-only view of the status page through the public URL (/view), passcode login.
  remote_view: true,
  remote_approve: false,

  // gemweb / webhub (dispatch to Gemini and ChatGPT web in dedicated visible Chrome windows)
  gemweb: {
    default_account: 'default',  // account used when --account is omitted
    auto_failover: true,         // spill over to another healthy account when the default account hits limits/busy slots
    accounts: {},                // extra named accounts: { [name]: { label, sites, cdp_url, profile_dir, concurrency, daily_limit, ... } }
    concurrency: 3,              // up to 3 concurrent conversations per (site, account)
    min_interval_sec: 10,        // at least this long between two task starts per site
    daily_limit: 30,             // tasks sent per local day and site; 0 = no cap
    limit_cooldown_min: 180,     // after a usage-limit notice, refuse new tasks this long (webhub limit clear)
    // "cdp": the dedicated Chrome (own profile ~/.web-ai-hub/chrome-profile, CDP on cdp_url).
    // "browsermcp": the owner's everyday Chrome through the Browser MCP extension (opt-in only, Gemini only).
    browser: 'cdp',
    owner_chrome_fallback: false, // true: if the dedicated Chrome is not signed in / not running, use the owner's Chrome
    headless: false,             // visible dedicated Chrome window by default (Tab 1 hosts the Monitor Dashboard)
    window_size: '1120,760',     // compact dedicated window size
    window_position: '24,48',    // top-left corner instead of screen center
    launch_in_background: true,  // on macOS, launch Chrome behind active windows (`open -g`) without stealing focus
    browsermcp_command: ['/opt/homebrew/bin/npx', '-y', '@browsermcp/mcp@2.5.0'],
    cdp_url: 'http://127.0.0.1:9230',
    profile_dir: '~/.web-ai-hub/chrome-profile',
    chrome_path: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    gemini_url: 'https://gemini.google.com/app?hl=en', // custom apps (MCP connectors) only work with the English UI; hl=en changes no account setting
    connector_name: 'Local Projects',
    model_label: '',             // exact visible label in the Gemini model picker; empty = keep default
    chatgpt: {
      url: 'https://chatgpt.com/',
      idle_sec: 20,
      allow_pro: false,          // guard against accidentally spending Pro quota unless --allow-pro or explicit --model
    },
    report_timeout_sec: 1800,
    // Optional fallback when the scripted page steps fail: a cheap model drives the page through a
    // browser MCP (needs operator_bin, a DSH-compatible CLI, and its provider names). Empty = BLOCKED.
    operator_models: [],
    operator_bin: 'dsh',
    operator_provider: '',           // provider for chat-completions models in the operator CLI
    operator_responses_provider: '', // provider for "codex/..." (responses API) models
    operator_effort: 'low',
    operator_prices: {},         // USD per 1M tokens per model, e.g. {"codex/some-model": {"input":1,"cached":0.1,"output":8}}
    auto_confirm: true,          // click Gemini's own "confirm tool call" prompts (server-side policy still applies)
    // gemweb goal: keep starting one-small-step rounds until the done check passes
    goal: {
      max_rounds: 50,
      max_hours: 24,
      no_progress_rounds: 3,     // stop after this many rounds in a row that changed no files
      max_errors: 10,            // stop after this many failed rounds in a row (with backoff 1, 2, 4 … 30 min)
      round_timeout_sec: 1800,
      check_timeout_sec: 600,
      judge_models: [],          // text done-criteria: empty = operator_models
      notify_command: [],        // owner notifications: argv that gets one argument, a short message
      report_bot: '',            // technical problems (stalls, errors, limits) go to this Orca bot; empty = log only
    },
  },
};

function deepMerge(base, over) {
  if (Array.isArray(base) || typeof base !== 'object' || base === null) return over === undefined ? base : over;
  const out = { ...base };
  for (const [k, v] of Object.entries(over || {})) {
    out[k] = (k in base && typeof base[k] === 'object' && !Array.isArray(base[k]) && base[k] !== null) ? deepMerge(base[k], v) : v;
  }
  return out;
}

export function ensureStateDir() {
  fs.mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
  for (const d of ['logs', 'tasks', 'run']) fs.mkdirSync(path.join(STATE_DIR, d), { recursive: true, mode: 0o700 });
}

export function loadConfig() {
  ensureStateDir();
  let user = {};
  if (fs.existsSync(CONFIG_PATH)) {
    user = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } else {
    // Only the settings people edit; everything else follows DEFAULT_CONFIG (see src/config.js).
    const starter = { roots: DEFAULT_CONFIG.roots, dangerous_policy: DEFAULT_CONFIG.dangerous_policy, gemweb: { concurrency: DEFAULT_CONFIG.gemweb.concurrency, connector_name: DEFAULT_CONFIG.gemweb.connector_name, model_label: '' } };
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(starter, null, 2) + '\n', { mode: 0o600 });
  }
  const cfg = deepMerge(DEFAULT_CONFIG, user);
  cfg.roots = (cfg.roots || []).map((r) => ({ ...r, path: path.resolve(expandHome(r.path)) }));
  return cfg;
}

function rand(n = 24) { return crypto.randomBytes(n).toString('base64url'); }

// passcode: typed by the owner on the OAuth consent page and the remote view login.
// admin_token: local CLI (gemweb) -> admin API.  static_bearer: MCP Inspector / scripts.
export function loadSecrets() {
  ensureStateDir();
  let s = {};
  if (fs.existsSync(SECRETS_PATH)) s = JSON.parse(fs.readFileSync(SECRETS_PATH, 'utf8'));
  let changed = false;
  const want = {
    passcode: () => rand(9),
    admin_token: () => rand(),
    static_bearer: () => rand(),
    manual_client_id: () => 'gwm-' + rand(8),
    manual_client_secret: () => rand(),
    view_cookie_key: () => rand(32),
  };
  for (const [k, gen] of Object.entries(want)) if (!s[k]) { s[k] = gen(); changed = true; }
  if (changed) fs.writeFileSync(SECRETS_PATH, JSON.stringify(s, null, 2) + '\n', { mode: 0o600 });
  fs.chmodSync(SECRETS_PATH, 0o600);
  return s;
}

export function safeEqual(a, b) {
  const x = Buffer.from(String(a ?? '')); const y = Buffer.from(String(b ?? ''));
  if (x.length !== y.length) { crypto.timingSafeEqual(x, x); return false; }
  return crypto.timingSafeEqual(x, y);
}

export const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
export const newId = (prefix, n = 6) => `${prefix}_${crypto.randomBytes(n).toString('hex')}`;
