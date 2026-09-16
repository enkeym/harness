---
name: optimize
description: "Analyses token spend and harness settings and proposes optimisations — which models and tools eat the budget, where the cache misses, which rules and hooks get in the way. Facts first, then the edits, each backed by a number. User-invoked as /optimize."
disable-model-invocation: true
allowed-tools: Bash(node /home/enkeym/.ai-hooks/bin/usage-report.mjs:*), Bash(tokensave cost:*), Read, Grep, Glob
argument-hint: "[--days N | --project <name>]"
---

# /optimize

Work out where the tokens go and what in the current setup works against the
user. Back every edit with a number from the facts below — an edit to hooks or
rules breaks every session silently, and the user notices a day later.

## 1. Collect the facts

```
tokensave cost 30d --by-model
node ~/.ai-hooks/bin/usage-report.mjs --days 30 --sessions
```

Then as needed: `~/.ai-hooks/logs/usage.jsonl` (raw per-session records),
`~/.claude/rules/core.md`, `~/.claude/CLAUDE.md`, `~/.claude/skills/*/SKILL.md`,
`~/.claude/settings.json`.

## 2. What to look for

Look for a cause, not an anomaly. Every observation is checked against the data,
otherwise it is a guess.

- **Wrong model for the job.** Opus where sonnet suffices, or a cheap model
  that takes three times the turns and ends up costing more. Look at messages
  per session, not just the total.
- **Cache missing.** A hit rate in `tokensave cost` noticeably below 90% means
  something breaks the prefix: changing text at the start of the context, a
  CLAUDE.md edit mid-work, jumping between models.
- **Subagents ran at all.** The harness has none; a `subagents > 0` in the
  ledger means a built-in agent (`Explore`, `Plan`) slipped through the rule —
  find the session and the prompt that caused it.
- **Tools run for nothing.** The top calls in the report: a lot of `Grep` and
  `Read` with a live index means the tool-choice rule didn't fire; many repeats
  of one call means a guard or a loop — that is `/doctor`.
- **A tool that costs more per call.** Divide ~tokens by calls in the report's
  context-sources block for `Read`, `tokensave_read`, `tokensave_body`, `Bash`
  and compare. Under 50 calls for a tool → report "рано судить", not a verdict.
  Whole-file `tokensave_read` next to a `Read` of the same file before an edit
  means the file is paid for twice.
- **Rules working against themselves.** CLAUDE.md sections contradicting each
  other or the skills; skills never loaded because nothing triggers them; bans
  with no working alternative — the agent looks for a way around those.

## 3. Report

Numbers first, in one block, then proposals sorted by size of win. Each proposal
in this shape:

```
<what to change> — <what it is based on, with a number> — <expected effect> — <what we risk>
```

Apply the edits one at a time, each as its own commit in `~/harness`, and run
the hook tests afterwards.

Nothing to optimise — say exactly that. A list of invented improvements is worse
than an empty report: people start changing what works.
