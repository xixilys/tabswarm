#!/bin/bash
# Public tunnel -> local MCP public listener.
#  - Named tunnel (fixed URL) when $STATE/cloudflared.yml exists: its own config + credentials,
#    separate from ~/.cloudflared/config.yml (the other production tunnels are not touched).
#    The public URL is config.json "public_base_url".
#  - Otherwise a Cloudflare quick tunnel (trycloudflare.com); its URL changes on every restart.
# The current URL is written to $STATE/run/tunnel-url for gwmcp / the status page.
set -u
if [ -n "${WEBHUB_STATE_DIR:-${GWM_STATE_DIR:-}}" ]; then STATE="${WEBHUB_STATE_DIR:-$GWM_STATE_DIR}"
elif [ -d "$HOME/.gemini-web-mcp" ]; then STATE="$HOME/.gemini-web-mcp"; else STATE="$HOME/.tabswarm"; fi
CLOUDFLARED="$(command -v cloudflared || echo /opt/homebrew/bin/cloudflared)"
cfgget() { /usr/bin/python3 -c "import json,sys;print(json.load(open(sys.argv[1])).get(sys.argv[2],sys.argv[3]))" "$STATE/config.json" "$1" "$2" 2>/dev/null || echo "$2"; }
PORT="$(cfgget public_port 8781)"
URLFILE="$STATE/run/tunnel-url"
NAMED="$STATE/cloudflared.yml"
mkdir -p "$STATE/run"
rm -f "$URLFILE"
trap 'rm -f "$URLFILE"' EXIT

if [ -f "$NAMED" ]; then
  BASE="$(cfgget public_base_url '')"
  "$CLOUDFLARED" tunnel --config "$NAMED" --no-autoupdate run 2>&1 | while IFS= read -r line; do
    echo "$line"
    if [[ "$line" == *"Registered tunnel connection"* ]] && [ -n "$BASE" ] && [ ! -s "$URLFILE" ]; then
      echo "${BASE%/}" > "$URLFILE"
      echo "[gwm-tunnel] MCP URL: ${BASE%/}/mcp"
    fi
  done
  exit 0
fi

echo "no-autoupdate: true" > "$STATE/run/empty-cloudflared.yml"   # keep ~/.cloudflared/config.yml out of this process
"$CLOUDFLARED" tunnel --config "$STATE/run/empty-cloudflared.yml" --no-autoupdate --protocol http2 \
  --url "http://127.0.0.1:$PORT" 2>&1 | while IFS= read -r line; do
  echo "$line"
  if [[ "$line" =~ (https://[a-z0-9-]+\.trycloudflare\.com) ]]; then
    echo "${BASH_REMATCH[1]}" > "$URLFILE"
    echo "[gwm-tunnel] MCP URL: ${BASH_REMATCH[1]}/mcp"
  fi
done
