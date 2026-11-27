# Contributing

Thanks for helping. A few things keep this project safe for the people who run it.

## Ground rules

* **Never sign in for anyone, never fake browser signals, never bypass usage limits.** tabswarm
  drives a browser the owner signed into by hand. Changes that add stealth (fingerprint spoofing,
  CAPTCHA solving, rotating accounts to dodge limits) will not be merged.
* **Tests never touch a real browser or account.** Web tasks in tests use the mock driver
  (`--driver mock`, or `gemweb.driver: "mock"` in the test config). Agents use
  `scripts/fixtures/fake-agent.sh`, and the gateway uses a fake HTTP server. Every suite starts
  its own hub on a temp state dir and fixed test ports. A test config also points the browser
  settings at an unused port and a throwaway profile, so a lost flag cannot reach a real Chrome.
* **No secrets or personal data in the repo.** That covers cookies, profiles, tokens, emails,
  chat logs and personal paths. CI runs a secret scan.

## Setup

```bash
npm ci
npm test                       # all suites (~5-10 min); each prints "N passed, M failed"
node scripts/swarm-test.mjs    # a single suite
```

The suites need macOS for the command sandbox (`sandbox-exec`) and Google Chrome for the
browser tests. `scripts/embedded-test.mjs` skips itself unless `desktop/node_modules` has
Electron (`cd desktop && npm ci`).

## Code layout

| Path | What |
|---|---|
| `src/server.js` | hub: MCP endpoint, OAuth, admin API, dashboard, task store, slots |
| `src/tools.js` | the MCP tools the web models get |
| `src/driver.js`, `src/sites.js` | page driving for Gemini / ChatGPT (all selectors live in `sites.js`) |
| `src/ask.js`, `src/targets.js`, `src/gateway.js`, `src/sessions.js` | `ask`: targets, gateway, sessions |
| `src/swarm.js` | swarm plans, runner, planner |
| `src/agents.js` | local agent backends |
| `src/accounts.js`, `src/browser.js`, `src/login*.js` | accounts, dedicated browser, sign-in helpers |
| `bin/webhub.mjs` | the CLI (`tabswarm` / `webhub`) |
| `desktop/` | Electron app with the embedded browser |
| `scripts/*-test.mjs` | test suites (plain Node scripts, no framework) |

## Pull requests

* Keep changes focused. Add a check to the closest suite for every behaviour you change.
* When the web UI changes, fix the selector or step in `src/sites.js`, and describe in the PR
  what you saw on the page (no screenshots of real chats).
* Update `CHANGELOG.md` under "Unreleased".
