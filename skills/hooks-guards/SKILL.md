---
name: hooks-guards
description: "How the local hook system behaves — security-guard, ask-guard, skill-gate, the edit/read/bash routers, background index sync, project-bootstrap — and how to react when one blocks or warns. Load when a hook refuses or warns, when ask mode, a guard, a permission prompt or a secret file is in question, when background indexing or project bootstrap comes up, or before reporting a tooling failure."
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

## skill-gate

- Denies an edit of a SKILL.md, `skills/*/reference/*.md`, `commands/*.md` or
  any `CLAUDE.md` until `skill-authoring` is loaded in this session, and a
  `git commit` until `review-standards`, `review-security` and `git-flow` are.
- The refusal names the missing skill: load it with `Skill(<name>)`, do what
  it says (the review skills mean running the checklist on the diff, not just
  loading), then repeat the call. Loaded-state is per session — after `/clear`
  the skills are gone from your context and from the gate alike.
- A prompt the user started with `/<skill>` counts as loaded.

## Routers

- Edit, read-search and bash routers steer calls to tokensave/ragsave and clip
  oversized output. They fire only on indexed files; agent configs
  (`.claude/`, `.opencode/`, `~/.ai-hooks/`) are excluded.
- A router or breaker block ≠ missing index. Call `tokensave_status` first.
  Index alive → `tokensave_read` / `tokensave_context` / `tokensave_str_replace`
  (load via `ToolSearch('select:mcp__tokensave__…')`). Real `tokensave_*` error
  or empty result → quote it, then `Read`/`Edit`/`Write` for that file; the
  router lets that second call through. Bash never gets the pass.
- `node <file>` (`python`, `bun`, `deno` alike) with no `-e`/`-p`/`-c` and no
  heredoc is a run, not a read: `node ~/.ai-hooks/bin/<script>.mjs` and the
  README's commands pass; the inline-code forms stay blocked.

## Background hooks

- They sync an **existing** tokensave/ragsave index; creating one is the
  user's call — say `tokensave init <path>` is needed, don't offer to run it.
- MCP servers start through `~/.ai-hooks/bin/mcp-serve.sh`, pinned to the
  session directory. Outside a project the server doesn't come up — tools are
  absent, not wrong.
- `links-context` (PostToolUse on read/edit tools, native and tokensave)
  injects a domain file of the project's impact map when the touched path
  matches its `paths:` — once per session per domain. Treat the text as the
  map's lines for this change: check them, add the missing link to that
  file. Silent ≠ no links: a domain without `paths:` is reached only through
  `INDEX.md`, so the impact pass still reads the index.
- `project-bootstrap` reports a missing project `CLAUDE.md`, husky, CI,
  dependabot, `.env.example`, or an impact map in an indexed project: offer
  in one line in the first reply (`/impact-map` for the map). Silent hook =
  deliberate skip (`<project>/.claude/bootstrap-ignore`).

## When something is broken

1. `~/.ai-hooks/logs/hooks.jsonl` — one line per hook decision (`deny`, `ask`,
   `breaker-open`, `server-mismatch`, `slow`, `crash`) with `sid`, `target`,
   `ms`; allowed calls are not written. The per-session trace of "what
   blocked, what came next".
2. `~/.ai-hooks/logs/errors.log` — background task failures and hook crashes
   (`exit=crash`); first read on any tokensave/ragsave report.
3. `~/.ai-hooks/logs/guard.log` (JSONL) — only real events: `server-mismatch`
   (MCP serves another project/branch; registry `~/.tokensave/servers/`),
   `breaker-open`. Marks live in `~/.claude/state/`.
4. Design docs: `~/.ai-hooks/README.md`, `~/.rag-mcp/README.md`. Tests:
   `~/.ai-hooks/test/test-*.mjs` — run after any edit under `~/.ai-hooks`; red
   → roll back, don't patch further.
5. Everything under `~/.claude/` is a symlink into `~/harness/claude/`;
   Edit/Write refuse symlinks — address the target path.
6. Deeper diagnosis is `/doctor` — offer it in one line, don't improvise. A
   prompt line starting `doctor (…)` is the background doctor's finding: its
   report is a file to `Read`, applying it is `/doctor apply`; a line starting
   `tokensave-гард молчит` means the routers are off for this session, not
   that the project is un-indexed.
