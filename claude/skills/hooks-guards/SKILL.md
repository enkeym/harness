---
name: hooks-guards
description: How the local hook system behaves — security-guard, ask-guard, the edit/read/bash routers, background index sync, project-bootstrap, subagent context — and how to react when one blocks or warns. Load when a hook refuses or warns about a call, when ask mode, a guard, a permission prompt or a secret file is in question, when background indexing or project bootstrap comes up, or before reporting a tooling failure.
---

# Hooks and guards

Hooks run outside your control and can block a call. Their output is user
feedback, not advice — a refusal is never a reason to look for a workaround, and
never a reason to reach for the shell.

## security-guard

Hard-blocks reading secret stores: `.env` and its derivatives, keys, certificates,
`auth.json`. What is read stays in the transcript forever, so the block is the
point. Take the shape of a variable from `.env.example` and its value from the
user.

Asks for confirmation on: database dumps, non-local databases, pushes to
protected branches, force push, deploy, remote-host commands, sending data
outward.

The guard judges the **form** of a command; `security-reviewer` judges the
**meaning** of code. Auth, payments, secrets and outbound calls still need the
reviewer even when every command passed the guard.

## ask-guard

In ask mode it blocks edits, mutating commands, publishing and writing subagents.
Reading, search, tests and read-only roles stay available, and an edit is shown
as a diff instead.

**Ask mode is never assumed.** It is on only if the statusline says so, or
`node ~/.ai-hooks/bin/ask-mode.mjs status` says so. A refusal whose text does not
mention ask mode has another source — security-guard, an ordinary permission
prompt, or the harness mode classifier. Name the real one; don't prescribe
`/ask-off` for something ask mode never blocked.

State is bound to the directory (git root) until the end of the session, and is
not inherited by a new one. The anchor is the session root (`CLAUDE_PROJECT_DIR`,
`workspace.project_dir`), not the working directory, which `cd` inside Bash moves
for the rest of the session — that drift used to leave the statusline and the
guard reading two different directories. `ask-mode.mjs status` prints the anchor
it used; compare it with the statusline when the two seem to disagree.

## Routers

The edit, read-search and bash routers steer calls to tokensave and ragsave and
clip oversized output. They fire only on files in the tokensave index; agent
configs (`.claude/`, `.opencode/`, `~/.ai-hooks/`) are excluded. A repeated
identical blocked call is let through — so if tokensave already failed once, say
so and use plain tools rather than retrying into the router.

## Background hooks

They keep an **existing** tokensave/ragsave index in sync — nothing more. Never
run `sync` yourself. First-time indexing is the user's call alone: no hook runs
`init` and none creates `.tokensave` / `.ragsave`. A project without an index
stays without one until the user runs `tokensave init <path>`; say so instead of
offering to do it.

MCP servers are started through `~/.ai-hooks/bin/mcp-serve.sh`, which pins the
project to the session's directory. Started outside a project, tokensave used to
pick the alphabetically first neighbouring project in silence; now the server
simply doesn't come up, and its tools are absent rather than wrong.

`project-bootstrap` reports a missing project `CLAUDE.md`, husky, CI, dependabot
or `.env.example` — offer it in one line in the first reply and act on "yes". If
the hook stayed silent, the skip is deliberate (`<project>/.claude/bootstrap-ignore`).

`SubagentStart` injects the tokensave/ragsave rules into every subagent, which is
why those rules don't belong in an agent prompt.

## When something is broken

Background failures land in `~/.ai-hooks/logs/errors.log` — read it first on any
tokensave or ragsave bug report; an empty file is also an answer.

`~/.ai-hooks/logs/guard.log` (JSONL) is the second file to open: it records only
where a guard stepped back, so anything in it is a real event. `server-mismatch`
— the MCP server serves another project or branch than the guard judges by (the
record names both, with the server registry from `~/.tokensave/servers/`);
`breaker-open` — the repeat breaker fired. Marks live in `~/.claude/state/`
(`guard-breaker.json`, `guard-log.json`), not under `~/.ai-hooks`.

Design docs: `~/.ai-hooks/README.md`, `~/.rag-mcp/README.md`. The hook test suite
is `~/.ai-hooks/test/test-*.mjs`; after any edit under `~/.ai-hooks` it is run,
and a red test means roll back, not patch further.

Editing a guard is propose-only: show the diff and wait for "yes", because a bug
in the guard core breaks every session silently. A deeper diagnosis is `/doctor`
— offer it in one line, don't improvise it.
