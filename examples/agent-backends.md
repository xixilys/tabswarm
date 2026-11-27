# Agent backend recipes

Local agent backends are argv templates in `config.json` → `agents.commands`, enabled by listing
them in `agents.backends`. Variables: `{prompt} {cwd} {dir} {last} {model} {effort} {account}
{chat}`. A `{x?}` element is optional: when `x` is empty it is dropped together with the flag
before it.

```json
{
  "agents": {
    "backends": ["claude", "codex", "agy", "agy-remote", "gateway", "web-chatgpt", "web-gemini"],
    "commands": {
      "agy": ["agy", "--model", "{model?}", "--print-timeout", "0", "-p", "{prompt}"],
      "agy-remote": ["/bin/sh", "-c", "ssh -o BatchMode=yes my-linux-box \"cd /tmp && agy --model {model} --print-timeout 0 -p \\\"\\$(cat)\\\"\" < \"{dir}/prompt.txt\""],
      "aider": ["aider", "--yes-always", "--message-file", "{dir}/prompt.txt"]
    }
  }
}
```

Then:

```bash
tabswarm ask --backend agy:gemini-4-neon-high --cwd ~/projects/foo "Design the plugin API"
tabswarm swarm run --backend agy:gemini-4-carbon-high,web:chatgpt "part 1" "part 2"
```

Notes:

* `agy` takes the prompt as the value of `-p`, so keep `-p "{prompt}"` last.
* Over SSH the prompt goes through stdin (`$(cat)` on the remote side), which avoids quoting
  problems with long prompts. `{model}` must be a plain model id.
* Agent output lands in `<cwd>/.gemweb/agents/<id>/` (`stdout.txt`, `stderr.txt`, `last.txt`,
  `exit_code`). The answer `ask` returns is `last.txt` if the agent wrote one, else stdout.
