# Tool-call limits of web chats

Web chats cap how much tool work one conversation can do. Neither Google nor OpenAI publishes the
numbers for custom MCP connectors, so this page records what this project's own event logs show
and how tabswarm works around the cap. Re-measure with the recipe at the end; the numbers move
with every model and UI release.

## What we measured (2026-11)

| Site / mode | Observation | How it ended |
|---|---|---|
| Gemini web, **Chat** mode (early 2026-11) | 8–9 tool calls per turn, at most 9 seen; one 13-call case spread over two turns | The model **stopped calling tools on its own** and wrote a summary. No error was shown, and some summaries claimed things the tools never did. |
| Gemini web, **Task** mode (the default here) | 109 tool calls in **one** conversation and one turn (a 3D web game built with 7 local agents), plus several 25–53-call runs | No error. It ended normally with `report(final)`. |
| Gemini web, **Task** mode, dedicated probe (2026-11-27) | Asked for 150 `list_roots` calls in one turn: it made **113 + 5 `report` = 118 tool calls**, then stopped | Gemini's runtime gives one turn a budget of **120 model steps**; every tool call uses one. Near the end the model sees `Note: You have 3 model calls remaining (call 118 of 120). Plan your remaining work accordingly.` It used the last steps for `report(final)` and its answer. Nothing was shown on the page: no error, no banner. |
| ChatGPT web (Thinking levels) | Up to 34 tool calls in one conversation | No error. It ended normally with `report(final)`. |

So in practice:

* **There is no hard error.** The cap shows up as **silent stopping**. The model ends its turn
  early (with a summary and no `report(final)`, or a `report(progress)`), and may say it is done
  when it is not. Do not trust the closing message; check `webhub trace <task_id>` and the files.
* **Gemini Task mode: about 117 tool calls per turn.** The budget is 120 model steps per turn,
  and the model is only warned 3 steps before the end. A model that ignores the warning just
  stops, with no final report. Chat mode stops far earlier (8–9). The driver always switches
  Gemini to Task mode.
* The cap applies per turn, not per chat. A follow-up message in the same chat often
  continues the work, but long chats get slower and less reliable.

## What tabswarm does about it

1. **It counts calls per conversation.** Every MCP call carries the task id. `ask --session NAME`
   adds them up per chat (`webhub session list` shows "calls in current chat").
2. **It rolls over before the cap.** When the current chat of a session has used
   `sessions.max_tool_calls.<site>` calls (default 80: under the ~117-call turn budget, and long
   chats get slow anyway), the next turn opens a **new chat**. Its
   first message is a handoff: the original request, the last turns' summaries, and a "check
   the disk before redoing anything" rule.
3. **It continues a stalled task.** If a web task stops without `report(final)` after using at
   least 75 % of the budget, `ask` re-sends it in a fresh chat with a handoff (up to
   `sessions.max_continue`, default 2). Only then does it give up and let a swarm retry or fall
   back.
4. **It keeps web models off the tool treadmill.** The prompt and the MCP server instructions
   tell the model to:
   * batch: one `run_command` with a short script instead of ten small calls;
   * delegate: `agent_spawn` / `swarm_start` hand tool-heavy work to local agents in one call;
   * wait instead of polling: `agent_status` and `swarm_status` take `wait_sec` (up to 45 s,
     the MCP client timeout is ~60 s);
   * use its own calls for planning, coordination and review.

Tune it in `config.json`:

```json
{ "sessions": { "max_tool_calls": { "gemini": 80, "chatgpt": 80 }, "max_continue": 2, "handoff_turns": 6 } }
```

## Thinking level and model

* Gemini web: `--model Neon|Carbon|Hydrogen` (any visible picker label; "Neon", "4 Neon" and
  "Deeper analysis" all match) and `--effort low|medium|high` (the "Thinking level" submenu).
  Both are read back from the page before the prompt is sent. If the readback does not match,
  the task stops with `BLOCKED: model-unavailable`.
* ChatGPT web: `--model "<picker label>"`; `--effort` picks a reasoning level on the slider. Pro
  levels need `--allow-pro`.
* Choosing a model or level in the picker changes the **account's** current setting for new chats
  too, just as clicking it by hand would.
* Seen live (2026-11): after a thinking-level change, the picker label reads "<model> <level>".
  If you then switch models in the same chat, the picker ignores clicks until the page reloads.
  The driver retries once and reloads a new, empty chat, so `--model X --effort Y` still works.
  It cannot reload a chat with history, so pick the model and level when the chat starts.

## Re-measuring

```bash
webhub ask --backend web:gemini --cwd ~/projects/scratch \
  "Call list_roots 150 times in a row, one call each, counting. After each 25 calls send report(status='progress', summary='<n> calls'). When you cannot call tools any more, say why, then report(final) with the count."
webhub trace <task_id>      # count the list_roots calls and see how the turn ended
```
