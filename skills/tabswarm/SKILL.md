---
name: tabswarm
description: Ask ChatGPT web, Gemini web (Neon / Carbon / Hydrogen), a model gateway or a local coding agent from any agent, and run swarms (one goal split into parallel sub-tasks with retries and a merged answer) through the tabswarm hub. Use when you want a second model to plan, design or review; to fan a job out over several web chats or agents at once; to continue a named web conversation; or to list, watch or cancel such tasks.
---

# tabswarm

tabswarm drives real ChatGPT and Gemini web chats in a dedicated browser. The web model can use
this computer through the hub's MCP server. You talk to it with the `tabswarm` CLI, which is also
installed as `webhub`. Every command below works from any agent that can run a shell: Claude
Code, Codex, agy, any other agent CLI, or a script.

Check the hub first: `tabswarm ps` (exit 5 = not running: `tabswarm start`).

## Ask one model (stdout = the answer only)

```bash
tabswarm ask --backend web:gemini --model Neon --effort high --cwd "$PWD" "Design the cache layer; list the trade-offs."
tabswarm ask --backend web:chatgpt "Review this plan for gaps" -f plan.md
echo "Summarize the diff" | tabswarm ask --backend gateway:<model-id>     # prompt on stdin
tabswarm ask --backend codex --cwd "$PWD" "Fix the failing test in tests/test_x.py"
tabswarm ask --backend carbon --session design-42 "Next step?"           # continue a named conversation
tabswarm ask --backend web:gemini --chat https://gemini.google.com/app/<id> "follow-up"
```

* `--backend` takes a target: `web:gemini[:MODEL[:low|medium|high]]`,
  `web:chatgpt[:MODEL[:EFFORT]]`, `gateway[:MODEL]`, a local agent backend (`claude`, `codex`,
  anything in `agents.commands`), or an alias (`neon`, `carbon`, `hydrogen` = Gemini web with
  that model; `config.models` adds or overrides them). `tabswarm targets` lists what this machine
  has.
* Exit codes: 0 answered, 2 usage, 3 blocked (rate limit, login, model not in picker, the model
  reported blocked), 4 timeout or failed, 5 hub not running. Progress and details go to stderr.
* `--json` prints a result object (`answer`, `status`, `task_id`, `chat_url`, `tool_calls`, ...).
* `--session NAME` keeps one conversation across calls. A web session moves to a fresh chat with a
  handoff summary once the chat has used its tool-call budget (see `docs/limits.md`).

## Swarm: split a goal, run the parts in parallel, get one merged answer

```bash
# let a model plan it, then run it (planner and workers can be any targets)
tabswarm swarm plan "Audit the repo for security issues and propose fixes" \
  --planner carbon --workers web:chatgpt,web:gemini:Neon,codex --max-tasks 5 --cwd "$PWD" --run --wait

# or give the plan yourself
tabswarm swarm start plan.json --wait            # see examples/swarm-plan.json
tabswarm swarm run --backend web:chatgpt,web:gemini "part one ..." "part two ..."

tabswarm swarm list
tabswarm swarm status <id> [--watch] [--answers] [--json]
tabswarm swarm result <id> [--wait]              # final.md: the synthesis (or all answers)
tabswarm swarm cancel <id>
tabswarm swarm retry <id> [task-id ...]          # run failed parts again
tabswarm swarm resume <id>                       # after a reboot or a killed runner
```

A plan task has `id, prompt, backend, fallback[], depends_on[], cwd, account, session`. A failed
attempt is retried (`max_retries`, default 2), each time on the next target in
`[backend, ...fallback]`. A dependent task gets the answers of the tasks it depends on. At the
end the swarm synthesizes one answer unless `synthesize` is `false`. `concurrency` caps the
parallel parts (default 4). Web parts also wait for the hub's per-account browser slots.

## Monitor and stop

```bash
tabswarm ps [--probe]          # accounts, open chats, running MCP calls, local jobs/agents, swarms
tabswarm watch [task_id]       # live event stream (swarms show as task "swarm:<id>")
tabswarm trace <task_id>       # every MCP call a web chat made; verify claims here, not in its summary
tabswarm cancel <task_id>      # stop a web task, its jobs and tabs
tabswarm kill <job_id|ag_id>   # stop one local job or agent
```

## Web models as coordinators (MCP tools)

Inside a web chat, the model has `agent_spawn` (a local agent, or another web chat with
`backend=web-gemini|web-chatgpt` plus `model`/`effort`/`chat_url`), `agent_status(wait_sec)` and
`agent_result`. It also has `swarm_start` (a whole plan in one call), `swarm_status(wait_sec,
cancel, retry)` and `swarm_result`. So a web model can plan, hand work to local and other web
agents, collect their answers and re-run failures. To start one:

```bash
tabswarm ask --backend web:gemini --model Carbon --cwd "$PWD" \
  "You coordinate. Split the job below into 3-5 parts, start them with one swarm_start (backends: codex, web:chatgpt), wait with swarm_status(wait_sec=40), re-run failures, then review and report the merged result. JOB: ..."
```

A swarm started by a swarm agent is depth 1. Deeper nesting is refused (`swarm.max_depth`).

## Rules

1. Check results on disk or in `tabswarm trace`. Web models sometimes claim work they did not do.
2. Keep each web prompt self-contained. Web chats do not see your context.
3. Prefer fewer, bigger tasks. Every web chat has a tool-call budget, so let local agents do the
   heavy tool work.
4. ChatGPT Pro levels are refused unless you pass `--model "<label>"` or `--allow-pro`.
