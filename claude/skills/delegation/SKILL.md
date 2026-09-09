---
name: delegation
description: Offloading bulky self-contained work to external models (DeepSeek, GLM, Codex) through delegate.mjs or the delegate subagent — what qualifies, which mode, how to report it, and what must never leave your own context. Load when a task is large, mechanical and verifiable and needs no project code: drafts, boilerplate from an exact spec, translations, regex, large-log analysis, or a second opinion.
---

# Delegation to external models

```
node ~/.ai-hooks/bin/delegate.mjs "task"   [--mode deep|jury] [--out FILE] [--health]
```

It spends DeepSeek / GLM / Codex quotas instead of the user's Claude budget.

## Delegate without asking when all three hold

1. The task is self-contained — the full statement fits in the prompt.
2. The answer is bulky — drafts, boilerplate from an exact spec, translations,
   regex, analysis of a large log, a second opinion on a written design.
3. The result is verifiable — you can check it against a spec, a compiler or a
   test, not just trust it.

Say in one line who you delegated to. A provider that didn't answer is reported
plainly, not retried in silence; `--health` says whether auth expired.

## Never delegate

- Anything that needs project code — the external model has no repo and no index.
- One-line questions: the round trip costs more than the answer.
- High-cost decisions: architecture, security, migrations.
- Anything carrying secrets or proprietary code in the prompt.

## Modes

- default — one provider, one pass.
- `--mode deep` — a longer, more careful pass for a task worth the wait.
- `--mode jury` — several providers on the same question when you want
  disagreement surfaced rather than one confident answer.
- `--out FILE` — the answer goes to a file instead of the transcript. Use it past
  roughly 50 lines.

Past ~50 lines or several attempts, use the `delegate` subagent instead: it
writes to a file and returns a summary, so the bulk never enters your context.

## After it comes back

The external answer is a draft, not a merge. Read it, check it against the
project's conventions and types, and take responsibility for what you keep — a
delegated mistake is still your mistake.
