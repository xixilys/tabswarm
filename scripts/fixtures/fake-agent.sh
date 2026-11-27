#!/bin/sh
# Fake agent CLI for scripts/agent-test.mjs: fake-agent.sh <backend> [-o LASTFILE] <prompt>
# Prompt keywords: SLEEP <n>, HANG, FAIL, LONG. Writes agent-<backend>.txt in its cwd.
backend="$1"; shift
last=""
if [ "$1" = "-o" ]; then last="$2"; shift 2; fi
prompt="$*"
case "$prompt" in *HANG*) sleep 600 ;; esac
n=$(printf '%s' "$prompt" | sed -n 's/.*SLEEP \([0-9][0-9]*\).*/\1/p'); [ -n "$n" ] && sleep "$n"
echo "progress line from $backend" >&2
case "$prompt" in *FAIL*) echo "fatal: something broke in $backend" >&2; exit 3 ;; esac
echo "done by $backend" > "agent-$backend.txt"
echo "state_dir=${GWM_STATE_DIR:-unset}" > "agent-$backend.env"
case "$prompt" in *LONG*) i=0; while [ $i -lt 400 ]; do echo "line $i of a long answer ................................"; i=$((i+1)); done ;; esac
echo "FINAL: $backend finished: $prompt"
[ -n "$last" ] && echo "LAST MESSAGE from $backend" > "$last"
exit 0
