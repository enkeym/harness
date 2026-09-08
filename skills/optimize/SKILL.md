---
name: optimize
description: Analyse token spend and agent-system settings and propose optimisations — which models and subagents eat the budget, where the cache misses, what should be delegated to external models, which rules and hooks get in the way. Analysis and proposals only; edits are applied on an explicit yes. User-invoked as /optimize.
disable-model-invocation: true
allowed-tools: Bash(node /home/enkeym/.ai-hooks/bin/usage-report.mjs:*), Bash(tokensave cost:*), Bash(node /home/enkeym/.ai-hooks/bin/delegate.mjs --health), Read, Grep, Glob
argument-hint: [--days N | --project <name>]
---

# /optimize

You work out where the tokens go and what in the current setup works against the
user. **You change nothing without their "yes"** — an edit to hooks or rules
breaks every session silently, and they notice a day later.

## 1. Collect the facts

```
tokensave cost 30d --by-model
node ~/.ai-hooks/bin/usage-report.mjs --days 30 --sessions
node ~/.ai-hooks/bin/delegate.mjs --health
```

Then as needed: `~/.ai-hooks/logs/usage.jsonl` (raw per-session records),
`~/.claude/CLAUDE.md`, `~/.claude/skills/*/SKILL.md`, `~/.claude/agents/*.md`,
`~/.claude/settings.json`.

## 2. What to look for

Look for a cause, not an anomaly. Every observation is checked against the data,
otherwise it is a guess.

- **Wrong model for the job.** Roles on opus where sonnet suffices, or a cheap
  model that takes three times the turns and ends up costing more. Look at
  messages per session, not just the total.
- **Cache missing.** A hit rate in `tokensave cost` noticeably below 90% means
  something breaks the prefix: changing text at the start of the context, a
  CLAUDE.md edit mid-work, jumping between models.
- **Subagents run for nothing.** A dispatch where one `tokensave_context` had
  the answer; several roles for a single-file task.
- **Tools run for nothing.** The top calls in the report: a lot of `Grep` and
  `Read` with a live index means the tool-choice rule didn't fire; many repeats
  of one call means a guard or a loop — that is `/doctor`.
- **Not delegated.** Bulk generation needing no repo context that would have
  gone to DeepSeek or GLM in seconds, on someone else's quota.
- **Rules working against themselves.** CLAUDE.md sections contradicting each
  other or the skills; skills never loaded because nothing triggers them; bans
  with no working alternative — the agent looks for a way around those.

## 3. Report

Numbers first, in one block, then proposals sorted by size of win. Each proposal
in this shape:

```
<what to change> — <what it is based on, with a number> — <expected effect> — <what we risk>
```

Don't apply the edits. Show what you propose as a diff and wait. On "yes", apply
one at a time, each as its own commit in `~/.ai-hooks` if the edit lands there,
and run the hook tests afterwards.

Nothing to optimise — say exactly that. A list of invented improvements is worse
than an empty report: people start changing what works.
