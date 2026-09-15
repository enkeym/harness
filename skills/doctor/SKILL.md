---
name: doctor
description: Diagnoses failures of the harness itself — loops, repeated guard refusals, dead background indexing, expired external CLI auth, an unresponsive MCP server, a crashing or slow hook, odd session behaviour. Reads logs and state, names the cause, proposes a hook or rule fix. Also runs headless in the background when a hook records breaker-open or server-mismatch; `/doctor apply` acts on that report. User-invoked as /doctor.
disable-model-invocation: true
allowed-tools: Bash(tail:*), Bash(ps:*), Bash(claude mcp list), Bash(claude plugin list), Bash(node /home/enkeym/.ai-hooks/test/*), Bash(node /home/enkeym/.ai-hooks/bin/doctor-applied.mjs:*), Bash(git -C /home/enkeym/harness *), Read, Grep, Glob
argument-hint: [what broke, in your own words | apply | server-mismatch]
---

# /doctor

Fix the system that serves the session — hooks, guards, indexes, external
CLIs — not the project's code. The symptom is in `$ARGUMENTS`; empty → walk
the whole list and report. `apply` → start from **Background report**.

## 1. State

```
tail -60 ~/.ai-hooks/logs/hooks.jsonl
tail -40 ~/.ai-hooks/logs/errors.log
claude mcp list
```

`hooks.jsonl` is one JSON line per hook **decision**: `sid`, `hook`, `tool`,
`decision` (`deny` | `ask` | `breaker-open` | `server-mismatch` | `slow` |
`crash`), `target`, `reason`, `ms`. Read it as a sequence per `sid` — that is
the "refusal → what the model tried next → refusal again" trace. Allowed calls
are not logged, so a quiet file means a quiet session.

Then, per symptom: `~/.ai-hooks/state/guard-breaker.json` (which blocks fired
twice), `~/.ai-hooks/logs/guard.log`, the project's `.tokensave/sync.log` and
`.ragsave/sync.log`, `~/.claude/state/`.

## 2. Common causes

| Symptom | Where to look |
|---|---|
| The same call repeats, no answer comes | `hooks.jsonl`: `deny` lines on one target followed by `breaker-open`. The cause is usually tokensave — a `sync` in flight, the branch missing from the graph, detached HEAD |
| Guards went quiet, whole files are read with `Read` | `server-mismatch` in `hooks.jsonl`: the project is initialised but no live MCP serves this root and branch (`servers: 0`), or the server holds another branch's DB. Registry `~/.tokensave/servers/`, `ps` for `mcp-serve.sh` |
| "hook error" flashed, then work continued | `crash` in `hooks.jsonl`; stack in `errors.log` under `exit=crash`. Fix the hook, then run its test |
| Every tool call feels sticky | `slow` lines (`ms` > 800): a guard waiting on a sync lock or a slow sqlite open. `TS_GUARD_SYNC_WAIT_MS`, `syncBusy` in `guard-core.mjs` |
| "File is in the index" for a file that isn't | the graph branch drifted from the working one: `branch-meta.json`, the `branch add` log |
| MCP won't connect | the server was started outside the project: tokensave has several roots and asks for `-p`. Check from the project directory |
| Background indexing isn't running | `errors.log`; a concurrent `sync` is a normal skip, not a failure |
| The session "forgot" a rule | edits to CLAUDE.md or hooks are only picked up by a new session |

## 3. Background report

`breaker-open` (first open per class) and a fresh `server-mismatch` spawn this
skill headless: `claude -p`, read-only tools, budget-capped, one run per
project and symptom per 30 min and one per event fingerprint (session + tool
class; root + branch + guard DB) until the report is applied. It writes
`~/.claude/state/doctor/<key>-<ts>.md` and the next prompt gets a two-line
summary; running inside it, do not offer edits — the report is the
deliverable. Lines the child's own hooks write to `hooks.jsonl` carry
`doctor: 1` — skip them when reading a session trace. Kill switch:
`touch ~/.claude/state/doctor/off` (cleanup removes it after 14 days).

On `/doctor apply`:

1. `Read` the report named in the summary (or the newest in the directory).
2. Re-check its **Факт** line against the current log — a stale finding is not
   applied.
3. Continue with §4 as if the cause were your own.
4. Last, from the project directory:
   `node ~/.ai-hooks/bin/doctor-applied.mjs` — marks the report applied, so
   the reminder stops announcing it and the same fingerprint may spawn a
   re-check.

## 4. What to do with a finding

Name the cause in one sentence and back it with a line from a log — without one
it is a guess. Then:

- **A hook or rule fix** — apply it as its own commit in `~/harness`.
- After an applied fix, always run the tests:
  `node ~/.ai-hooks/test/test-guards.mjs`, `test-ask-mode.mjs`,
  `test-security.mjs`, `test-security-bypass.mjs`, `test-project-bootstrap.mjs`,
  `test-hooklog.mjs`, `test-doctor.mjs`. A red test means roll back, not patch
  further.
- **The failure is in the task, not the system** — say so plainly and return the
  user to normal work.
- **No cause found** — say that, listing what you checked. A blind edit in the
  guards is worse than an open question.

## Output (headless run)

```
Причина: <one sentence>
Факт: <the log line that proves it>
Предложение: <file and the change; or «причина не найдена, проверено: …»>
```
