# Changelog

## 0.3.0 — unreleased

First open-source release (new history).

### Added
- `ask`: one prompt → one answer for any target (web Gemini/ChatGPT, HTTP gateway, local agents),
  prompt on stdin, answer on stdout, exit codes 0/2/3/4/5, `--json`, `--result-file`.
- Targets and aliases: `web:gemini[:MODEL[:EFFORT]]`, `web:chatgpt[:MODEL]`, `gateway[@NAME][:MODEL]`,
  agent backends, `config.models` aliases (built in: `neon`, `carbon`, `hydrogen`, `gpt`).
- Gateway backend for Anthropic- and OpenAI-compatible endpoints.
- Named sessions (`--session`): web chats are continued; when a chat has used its tool-call budget
  the next turn moves to a new chat with a handoff summary; stalled tasks that ran out of budget
  continue in a new chat automatically.
- Swarms: plans with dependencies, fallbacks, retries, concurrency caps, synthesis; `swarm plan`
  (a model writes the plan), `start`, `run`, `status --watch`, `result`, `cancel`, `retry`, `resume`;
  HTTP API and events; listed in `ps`/state.
- MCP tools `swarm_start`, `swarm_status` (wait / cancel / retry), `swarm_result`; `agent_spawn`
  takes `model`, `effort`, `account`, `chat_url`; `agent_status` takes `wait_sec`.
- Gemini web: model picked by its picker label (substring match, read back) and thinking level
  (`--effort low|medium|high`, read back).
- Prompt and server instructions that keep web models from burning tool calls (batch, delegate, wait).
- Docs: tool-call limits, scheduler backend interface, skill for agents, examples.

### Changed
- Generic defaults: allowed roots `~/projects`, agent backends `claude, codex, web-*, gateway`,
  no operator fallback, no owner notifications unless configured; state dir `~/.tabswarm`
  (an existing `~/.gemini-web-mcp` is still used); launchd label prefix configurable.

## 0.2.0 and earlier
Private project history (not included in this repository): multi-account dedicated browsers,
embedded desktop browser, MCP tools, dashboard, goal runner.
