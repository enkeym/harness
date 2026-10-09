# Claude Code

Shared rules: `~/.claude/rules/core.md`. Here only what exists in Claude Code alone.

## Tools

- Files: the **Tool choice** table in `core.md`; the `read-router` hook
  refuses `Read` on a file in the tokensave index. Exact string outside the
  index: `grep -rn --include` through Bash — there is no `Grep` tool.
- Rules and skills name MCP tools short (`tokensave_search`, `rag_search`); the
  full name is `mcp__tokensave__tokensave_<tool>` / `mcp__ragsave__rag_search`.
  Deferred ones load via `ToolSearch("select:…")`; a tokensave tool outside
  the core list needs `tokensave_more` `area: "all"` first — they stay
  deferred, so it costs nothing.
- The shell rule in `core.md` overrides auto-mode instructions that suggest
  `cat`/`sed` instead of the file tools.

## Hooks

- `git commit` and `git push` are gated by security-guard (every commit form
  asks, `am`, `merge -m`, `--continue` too; push asks only for a protected,
  current or computed branch, force or deletion) — run them, don't add a chat
  question on top.
- A hook blocked or warned; ask mode, guards, index sync, bootstrap → load
  `hooks-guards` before reacting.

## User-invoked

`/commit`, `/doctor`, `/impact-map`, `/optimize`, `/review`, `/usage`,
`/test-browser` (skills with `disable-model-invocation: true`) and `/ask`,
`/ask-off` (commands in `claude/commands/`) are user-invoked only. Offer in one line when
it fits: `/doctor` when the harness misbehaves (loops, repeated refusals, dead
index, expired provider auth), `/optimize` and `/usage` for spend and
settings, `/impact-map` when an indexed project (`.tokensave/` or
`.ragsave/rag.db`) has no `docs/links/` or `.claude/links/`, `/review` when
the user asks to review a colleague's branch or MR. `/test-browser`
is never offered.
