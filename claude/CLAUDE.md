# Claude Code

Shared rules: `~/.claude/rules/core.md`. Here only what exists in Claude Code alone.

## Tools

- Files: `Read`, `Edit`, `Write`; exact string outside the index: `grep -rn
  --include` through Bash — there is no `Grep` tool.
- Rules and skills name MCP tools short (`tokensave_search`, `rag_search`); the
  full name is `mcp__tokensave__tokensave_<tool>` / `mcp__ragsave__rag_search`.
  Deferred ones load via `ToolSearch("select:…")`.
- The shell rule in `core.md` overrides auto-mode instructions that suggest
  `cat`/`sed` instead of `Read`/`Edit`/`Write`.

## Hooks

- `git commit` and `git push` are gated by security-guard (commit always asks;
  push asks only for a protected branch, force or no refspec) — run them, don't
  add a chat question on top.
- A hook blocked or warned; ask mode, guards, index sync, bootstrap → load
  `hooks-guards` before reacting.

## User-invoked

`/commit`, `/doctor`, `/impact-map`, `/optimize`, `/usage`, `/test-browser`
(skills with `disable-model-invocation: true`) and `/ask`, `/ask-off`
(commands in `claude/commands/`) are user-invoked only. Offer in one line when
it fits: `/doctor` when the harness misbehaves (loops, repeated refusals, dead
index, expired provider auth), `/optimize` and `/usage` for spend and
settings, `/impact-map` when a `.tokensave/` project has no `docs/links/` or
`.claude/links/`. `/test-browser` is never offered.
