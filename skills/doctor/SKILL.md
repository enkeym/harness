---
name: doctor
description: "Diagnoses harness failures — loops, repeated guard refusals, dead indexing, expired CLI auth, an unresponsive MCP server, a slow hook, a startup settings warning, install drift — from logs and state, and proposes a fix. User-invoked as /doctor."
disable-model-invocation: true
allowed-tools: Bash(tail:*), Bash(ps:*), Bash(grep *), Bash(jq *), Bash(ls -t *), Bash(claude mcp list), Bash(claude plugin list), Bash(claude -p ok --max-turns 1 --debug), Bash(~/harness/install.sh --check), Bash(node ~/.ai-hooks/test/*), Bash(node ~/.ai-hooks/bin/tool-share.mjs *), Bash(git -C ~/harness *), Bash(git ls-remote *), Bash(tokensave status *), Bash(curl -sS --max-time 10 --fail-with-body -H *), Read, Grep, Glob
argument-hint: "[what broke, in your own words | session [sid]]"
---

# /doctor

Fix the system that serves the session — hooks, guards, indexes, external
CLIs — not the project's code. The symptom is in `$ARGUMENTS`; empty → walk
the whole list and report; `session [sid]` → section 4.

## 1. State

Harness and hooks:

```
claude mcp list
~/harness/install.sh --check
git -C ~/harness status --short && git -C ~/harness log --oneline @{u}..
for t in ~/.ai-hooks/test/test-*.mjs; do node "$t" >/tmp/doctor-test.out 2>&1 || { echo "RED $t"; tail -5 /tmp/doctor-test.out; }; done
jq -rs --arg since "$(date -u -d '1 day ago' +%FT%TZ)" 'map(select(.ts > $since)) | group_by(.hook, .decision)[] | [.[0].hook, .[0].decision, length, (map(.ms // 0) | max)] | @tsv' ~/.ai-hooks/logs/hooks.jsonl | column -t
tail -60 ~/.ai-hooks/logs/hooks.jsonl
tail -40 ~/.ai-hooks/logs/errors.log
```

The test loop takes ~40 s; a red test outranks any log line as evidence. The
`jq` line is hook, decision, count, max `ms` over 24 h — a hook whose count
jumped is where to read the tail.

From the project directory — settings, auth, indexes:

```
claude -p ok --max-turns 1 --debug 2>&1 | grep -E '^Permission (allow|deny|ask) rule|[Ii]nvalid'
GIT_TERMINAL_PROMPT=0 git ls-remote origin HEAD >/dev/null && echo "origin: ok"
[ -n "$GITLAB_HOST" ] && curl -sS --max-time 10 --fail-with-body -H "PRIVATE-TOKEN: $GITLAB_TOKEN" "https://$GITLAB_HOST/api/v4/user" | jq -r .username
tokensave status --json | jq -c '{files: .file_count, last_sync: (.last_sync_at | todate)}'
git log -1 --format=%cI && git status --short | wc -l
```

plus `rag_status`.

- Settings are validated only at session start, `claude mcp list` skips them;
  the `claude -p` line loads the project's settings too.
- `ls-remote` fails → the git credentials for `origin` expired. `/user` 401 →
  `GITLAB_TOKEN` expired or `GITLAB_HOST` wrong in `~/.config/harness/env`;
  `GITLAB_HOST` empty → MR delivery is off, not broken. Never print the token.
- An index is stale when its last sync is older than the last commit or an
  uncommitted edit. `rag_status`: `autosync` not `ok`, `last_sync.report.errors`
  above 0, or `model` ≠ `current_model` (full reindex) → read
  `.ragsave/sync.log`.

`hooks.jsonl` is one JSON line per hook **decision**: `sid`, `hook`, `tool`,
`decision` (`deny` | `ask` | `block` | `slow` | `crash`), `target`, `reason`, `ms`. Read
it as a sequence per `sid` — that is the "refusal → what the model tried next
→ refusal again" trace. Allowed calls are not logged, so a quiet file means a
quiet session.

Then, per symptom: `~/.claude/state/`.

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

## 4. `/doctor session [sid]`

One finished session, checked for whether the harness steered it right.
Transcript: `~/.claude/projects/<project path, every non-alphanumeric → ->/<sid>.jsonl`;
no `sid` → the newest one other than the current. The directory name starts with
`-`: pass transcripts by absolute path (or after `--`), never a relative
`-home-…/x.jsonl` — `jq` and `basename` parse it as an option.

```
jq -r 'select(.type=="assistant") | .message.content[]? | select(.type=="tool_use") | [.name, ((.input.file_path // .input.path // .input.file // .input.command // .input.skill // "") | tostring | .[0:90])] | @tsv' <transcript>
jq -c --arg sid <sid> 'select(.sid == $sid)' ~/.ai-hooks/logs/hooks.jsonl
```

Each item ends as ok, failure or not met, with the line that proves it:

1. Refusals: one target refused twice in a row is a loop; a next call that is
   not the tool the refusal named is a bad refusal text.
2. Skills: every area the session edited (`rules/core.md` Skills table) has
   its `Skill` call before the first edit there; a `skill-gate` deny is a
   description that failed to trigger.
3. Tool choice: indexed files read through `Read` or shell instead of
   tokensave. Across sessions: `node ~/.ai-hooks/bin/tool-share.mjs`.
4. Questions: a `question-guard` block is a question left as prose.
5. Commit gate: each `git commit` follows `review-standards` and
   `review-security` `Skill` calls.
6. Hooks: `crash` or `slow` lines under this `sid`.
7. Context meter: its threshold text reached the transcript and the next turn
   followed it.

A failure → reproduce it by feeding the hook its JSON on stdin, then fix it
with a test as in section 3.
