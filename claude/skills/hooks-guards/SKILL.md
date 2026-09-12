---
name: hooks-guards
description: How the local hook system behaves — security-guard, ask-guard, the edit/read/bash routers, background index sync, project-bootstrap — and how to react when one blocks or warns. Load when a hook refuses or warns, when ask mode, a guard, a permission prompt or a secret file is in question, when background indexing or project bootstrap comes up, or before reporting a tooling failure.
---

# Hooks and guards

CLAUDE.md already says never route around a refusal. This names which hook
fired and what it wants instead.

## security-guard

- Hard-blocks reading secret stores: `.env*`, keys, certificates, `auth.json`.
  Take a variable's shape from `.env.example`, its value from the user.
- Asks confirmation: database dumps, non-local databases, pushes to protected
  branches, force push, deploy, remote-host commands, outbound data.
- Judges command **form**. Code *meaning* (auth, payments, secrets, outbound
  calls) still needs `review-security`.

## ask-guard

- In ask mode: blocks edits, mutating commands, publishing. Reads, search and
  tests stay; an edit is shown as a diff.
- Ask mode is on only if the statusline says so or
  `node ~/.ai-hooks/bin/ask-mode.mjs status` says so. A refusal that doesn't
  mention ask mode has another source — name it; don't prescribe `/ask-off`.
- State is bound to the session root (`CLAUDE_PROJECT_DIR`), not the cwd.
  `ask-mode.mjs status` prints the anchor it used.

## Routers

- Edit, read-search and bash routers steer calls to tokensave/ragsave and clip
  oversized output. They fire only on indexed files; agent configs
  (`.claude/`, `.opencode/`, `~/.ai-hooks/`) are excluded.
- A router or breaker block ≠ missing index. Call `tokensave_status` first.
  Index alive → `tokensave_read` / `tokensave_context` / `tokensave_str_replace`
  (load via `ToolSearch('select:mcp__tokensave__…')`). Real `tokensave_*` error
  or empty result → retry once, quote the error, then `Read`/`Edit`/`Write` for
  that file. Bash never gets the pass.

## Background hooks

- They sync an **existing** tokensave/ragsave index. Never run `sync`. Never
  run `init` or create `.tokensave`/`.ragsave` — that is the user's call; say
  `tokensave init <path>` is needed instead of offering to do it.
- MCP servers start through `~/.ai-hooks/bin/mcp-serve.sh`, pinned to the
  session directory. Outside a project the server doesn't come up — tools are
  absent, not wrong.
- `project-bootstrap` reports a missing project `CLAUDE.md`, husky, CI,
  dependabot or `.env.example`: offer in one line in the first reply. Silent
  hook = deliberate skip (`<project>/.claude/bootstrap-ignore`).

## When something is broken

1. `~/.ai-hooks/logs/errors.log` — first read on any tokensave/ragsave report.
2. `~/.ai-hooks/logs/guard.log` (JSONL) — only real events: `server-mismatch`
   (MCP serves another project/branch; registry `~/.tokensave/servers/`),
   `breaker-open`. Marks live in `~/.claude/state/`.
3. Design docs: `~/.ai-hooks/README.md`, `~/.rag-mcp/README.md`. Tests:
   `~/.ai-hooks/test/test-*.mjs` — run after any edit under `~/.ai-hooks`; red
   → roll back, don't patch further.
4. Everything under `~/.claude/` is a symlink into `~/harness/claude/`;
   Edit/Write refuse symlinks — address the target path.
5. Deeper diagnosis is `/doctor` — offer it in one line, don't improvise.
