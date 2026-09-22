---
name: doctor
description: "Diagnoses failures of the harness itself — loops, repeated guard refusals, dead background indexing, expired external CLI auth, an unresponsive MCP server, a crashing or slow hook, odd session behaviour. Reads logs and state, names the cause, proposes a hook or rule fix. User-invoked as /doctor."
disable-model-invocation: true
allowed-tools: Bash(tail:*), Bash(ps:*), Bash(claude mcp list), Bash(claude plugin list), Bash(node /home/enkeym/.ai-hooks/test/*), Bash(git -C /home/enkeym/harness *), Read, Grep, Glob
argument-hint: "[what broke, in your own words]"
---

# /doctor

Fix the system that serves the session — hooks, guards, indexes, external
CLIs — not the project's code. The symptom is in `$ARGUMENTS`; empty → walk
the whole list and report.

## 1. State

```
tail -60 ~/.ai-hooks/logs/hooks.jsonl
tail -40 ~/.ai-hooks/logs/errors.log
claude mcp list
```

`hooks.jsonl` is one JSON line per hook **decision**: `sid`, `hook`, `tool`,
`decision` (`deny` | `ask` | `slow` | `crash`), `target`, `reason`, `ms`. Read
it as a sequence per `sid` — that is the "refusal → what the model tried next
→ refusal again" trace. Allowed calls are not logged, so a quiet file means a
quiet session.

Then, per symptom: the project's `.ragsave/sync.log`, `~/.claude/state/`,
`tokensave status` from the project directory.

## 2. Common causes

| Symptom | Where to look |
|---|---|
| The same call repeats, no answer comes | `hooks.jsonl`: `deny` lines on one target. Read the reason — the guard names the tool to use instead |
| "hook error" flashed, then work continued | `crash` in `hooks.jsonl`; stack in `errors.log` under `exit=crash`. Fix the hook, then run its test |
| Every tool call feels sticky | `slow` lines (`ms` > 800): a hook waiting on a lock or a slow node start |
| tokensave answers from stale code | `tokensave status`; the server syncs on connect and before calls with a 30 s pause. `/mcp` → tokensave → Reconnect |
| MCP won't connect | the server was started outside the project: tokensave has several roots and asks for `-p`. Check from the project directory |
| ragsave sync isn't running | `errors.log`; a concurrent `sync` is a normal skip, not a failure |
| The session "forgot" a rule | edits to CLAUDE.md or hooks are only picked up by a new session |

## 3. What to do with a finding

Name the cause in one sentence and back it with a line from a log — without one
it is a guess. Then:

- **A hook or rule fix** — apply it as its own commit in `~/harness`.
- After an applied fix, always run the tests:
  `node ~/.ai-hooks/test/test-guards.mjs`, `test-ask-mode.mjs`,
  `test-security.mjs`, `test-security-bypass.mjs`, `test-project-bootstrap.mjs`,
  `test-hooklog.mjs`. A red test means roll back, not patch further.
- **The failure is in the task, not the system** — say so plainly and return the
  user to normal work.
- **No cause found** — say that, listing what you checked. A blind edit in the
  guards is worse than an open question.
