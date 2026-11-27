# Using tabswarm as a backend of another scheduler

tabswarm offers two interfaces a scheduler can drive without importing any of its code. Both
run on the machine where the hub and its browser live.

## 1. One prompt -> one answer: `tabswarm ask`

This is the shape of a `cmd:<shell>` provider in multi-agent schedulers, and of most "run a CLI
per job" setups:

| | |
|---|---|
| prompt | stdin (or `-f FILE`, or trailing words) |
| answer | stdout, nothing else |
| progress, details | stderr |
| outcome | exit code: `0` answered, `2` usage, `3` blocked (rate limit, login, model unavailable, the model reported blocked), `4` timeout or failed, `5` hub not running |
| working directory | the process cwd, or `--cwd` (must be inside the hub's allowed roots for tool use) |

Provider specs for such a scheduler:

```text
cmd:tabswarm ask --backend web:gemini --model Neon --effort high
cmd:tabswarm ask --backend web:chatgpt
cmd:tabswarm ask --backend gateway:<model-id>
cmd:tabswarm ask --backend carbon --session goal-<id>          # keeps one web conversation per goal
```

The target string itself follows the common `<pool>:<model>[:<effort>]` shape (`web:gemini:Neon:high`).
So a scheduler can also pass it through as one argument: `tabswarm ask --backend "$SPEC"`.

When the scheduler runs on another host (for example WSL while the browser runs on a Mac), wrap
the command in SSH: `cmd:ssh mac tabswarm ask --backend web:gemini`. stdin, stdout and the exit
code pass through SSH unchanged.

## 2. Queue a batch: swarms

```bash
id=$(tabswarm swarm start plan.json)          # returns at once with sw_xxxxxxxx
tabswarm swarm status "$id" --json            # {status, counts, tasks:[{id,status,backend,attempts,error,...}]}
tabswarm swarm result "$id" --json            # answers + synthesis once status != running
tabswarm swarm cancel "$id"
```

`status` is `running`, `done`, `partial` (some parts failed), `failed` or `cancelled`. The same
operations exist over HTTP on the hub's admin port (bearer = `admin_token` from the state dir's
`secrets.json`):

```text
POST /api/swarms              body = plan JSON          -> {swarm_id}
GET  /api/swarms              recent swarms (summaries)
GET  /api/swarms/<id>[?answers=1]
POST /api/swarms/<id>/cancel
```

Swarm events (`swarm.started`, `swarm.task_start`, `swarm.task_retry`, `swarm.task_end`,
`swarm.end`) appear in `GET /api/events?task_id=swarm:<id>` and `/api/stream`.

## Concurrency and fairness

* `swarm.concurrency` / a plan's `concurrency` caps the parts running at once in one swarm.
* `swarm.max_active` caps the swarms running at once (default 6).
* Web parts also queue for the hub's per-account, per-site browser slots (`concurrency` on each
  account) and respect daily caps and rate-limit pauses. A part that is refused moves to its
  next fallback target on retry.
