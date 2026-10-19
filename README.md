# dsh-tool-bash-parallel

A [DeepSeek Harness](https://dsh) plugin that adds a `bash_parallel` tool:
run 2–16 independent shell commands concurrently (`bash -c` each) in a single
tool call, with at most 10 in flight.

## Why

The harness overlaps parallel-safe tool calls, but the built-in `bash` tool
declares no `isConcurrencySafe`, so consecutive shell calls serialize.
Exploration work — list this, read those, grep for that — is independent by
nature and is exactly what this tool batches: one model turn, one tool call,
N commands in flight.

## Install

From the DeepSeek Harness UI or plugin manager, install from this directory:

```
plugin_manager: install_bundle  target: /path/to/tools
```

Or add it as a linked dependency in the profile's `package.json` and list
`@local/dsh-tool-bash-parallel` under `dsh.profile.bundles`.

## Tool

`bash_parallel` takes:

```json
{
  "commands": [
    { "command": "ls src", "workdir": "packages/app", "timeoutMs": 30000 },
    { "command": "cat package.json" }
  ],
  "concurrency": 10
}
```

- Each command runs in a fresh shell; commands cannot see each other's
  working directory, environment, or output.
- `workdir` is relative to the session's current directory; `timeoutMs`
  kills the command when it expires.
- Results keep input order. Per-command failures and timeouts are result
  data, never tool errors — check each `[exit code: N]` line.
- A system-prompt section nudges the model to put all independent commands
  of a step into one call instead of a few per call.

## Plugin

Registered on the host plane through a single bundle patch
(`cordis.patch.yml`), so every preset and session in the profile sees it.

| | |
|---|---|
| Package | `@local/dsh-tool-bash-parallel` |
| Entry id | `tool-bash-parallel` |
| Injects | `tools`, `shell`, `systemPrompt`, `shellEnv`, `workingDirectory` |
| Caps | 16 commands per call · 10 concurrent · 600 s tool timeout |

## License

MIT
