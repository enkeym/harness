---
name: doctor
description: Diagnose failures of the agent system itself — loops, repeated guard refusals, dead background indexing, expired external CLI auth, an unresponsive MCP server, odd session behaviour. Reads logs and state, names the cause, proposes a hook or rule fix. User-invoked as /doctor.
disable-model-invocation: true
allowed-tools: Bash(tail:*), Bash(claude mcp list), Bash(claude plugin list), Bash(node /home/enkeym/.ai-hooks/test/*), Bash(git -C /home/enkeym/.ai-hooks *), Read, Grep, Glob
argument-hint: [what broke, in your own words]
---

# /doctor

You are fixing the system that serves you — hooks, guards, indexes, external
CLIs — not the project's code. The user's symptom is in `$ARGUMENTS`; if it is
empty, walk the whole list and report what you found.

## 1. State

```
tail -40 ~/.ai-hooks/logs/errors.log
claude mcp list
```

Then, per symptom: `~/.ai-hooks/state/guard-breaker.json` (which blocks fired
twice), the project's `.tokensave/sync.log` and `.ragsave/sync.log`,
`~/.claude/state/`.

## 2. Common causes

| Symptom | Where to look |
|---|---|
| The same call repeats, no answer comes | `guard-breaker.json`: a guard blocked it and the alternative didn't work. The cause is usually tokensave — a `sync` in flight, the branch missing from the graph, detached HEAD |
| "File is in the index" for a file that isn't | the graph branch drifted from the working one: `branch-meta.json`, the `branch add` log |
| MCP won't connect | the server was started outside the project: tokensave has several roots and asks for `-p`. Check from the project directory |
| Background indexing isn't running | `errors.log`; a concurrent `sync` is a normal skip, not a failure |
| The session "forgot" a rule | edits to CLAUDE.md or hooks are only picked up by a new session |

## 3. What to do with a finding

Name the cause in one sentence and back it with a line from a log — without one
it is a guess. Then:

- **A hook or rule fix** — show it as a diff and wait for "yes". The user chose
  propose-only mode: a bug in the guard core breaks every session silently.
- After an applied fix, always run the tests:
  `node ~/.ai-hooks/test/test-guards.mjs`, `test-ask-mode.mjs`,
  `test-security.mjs`, `test-subagent-context.mjs`, `test-project-bootstrap.mjs`.
  A red test means roll back, not patch further.
- **The failure is in the task, not the system** — say so plainly and return the
  user to normal work.
- **No cause found** — say that, listing what you checked. A blind edit in the
  guards is worse than an open question.
