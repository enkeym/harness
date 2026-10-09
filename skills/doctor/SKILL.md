---
name: doctor
description: "Diagnoses harness failures — loops, repeated guard refusals, dead indexing, expired CLI auth, an unresponsive MCP server, a slow hook, a startup settings warning, install drift — from logs and state, and proposes a fix. User-invoked as /doctor."
disable-model-invocation: true
allowed-tools: Bash(tail:*), Bash(ps:*), Bash(grep *), Bash(claude mcp list), Bash(claude plugin list), Bash(claude -p ok --max-turns 1 --debug), Bash(~/harness/install.sh --check), Bash(node ~/.ai-hooks/test/*), Bash(git -C ~/harness *), Read, Grep, Glob
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
~/harness/install.sh --check
git -C ~/harness status --short && git -C ~/harness log --oneline @{u}..
claude -p ok --max-turns 1 --debug 2>&1 | grep -E '^Permission (allow|deny|ask) rule|[Ii]nvalid'
for t in ~/.ai-hooks/test/test-*.mjs; do node "$t" >/tmp/doctor-test.out 2>&1 || { echo "RED $t"; tail -5 /tmp/doctor-test.out; }; done
```

Run the `claude -p` line from the project directory — it loads that
project's settings too; settings are validated only at session start, `claude
mcp list` skips them. The test loop takes ~40 s; a red test outranks any log
line as evidence.

`hooks.jsonl` is one JSON line per hook **decision**: `sid`, `hook`, `tool`,
`decision` (`deny` | `ask` | `block` | `slow` | `crash`), `target`, `reason`, `ms`. Read
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
| Yellow warning at startup | the `claude -p` line names the rule and the settings file; fix that rule |
| A setting or skill edit stopped reaching git | `install.sh --check`: `/config` replaced a symlink with a file. `./install.sh` restores it, the file goes to `.bak-<date>` |
| Guards broke right after a harness edit | `git -C ~/harness status`: an uncommitted edit is live in every session; the red test names it |

## 3. What to do with a finding

Name the cause in one sentence and back it with a line from a log — without one
it is a guess. Then:

- **A hook or rule fix** — apply it as its own commit in `~/harness`.
- After an applied fix, rerun the test loop from step 1. A red test means
  roll back, not patch further.
- **The failure is in the task, not the system** — say so plainly and return the
  user to normal work.
- **No cause found** — say that, listing what you checked. A blind edit in the
  guards is worse than an open question.
