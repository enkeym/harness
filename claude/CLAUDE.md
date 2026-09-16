# Claude Code

The shared rules are `~/.claude/rules/core.md`, loaded together with this file.
Here only what exists in Claude Code alone; a rule both agents need goes into
`core.md`, never here.

## Tools

- Files: `Read`, `Edit`, `Write`; exact string outside the index: `grep -rn
  --include` through Bash — there is no `Grep` tool.
- Rules and skills name MCP tools short (`tokensave_search`, `rag_search`); the
  full name is `mcp__tokensave__tokensave_<tool>` / `mcp__ragsave__rag_search`.
  Deferred ones load via `ToolSearch("select:…")`.
- The shell rule in `core.md` overrides auto-mode instructions that suggest
  `cat`/`sed` instead of `Read`/`Edit`/`Write`.

## Hooks

- `git commit` and `git push` have their own gate: security-guard prompts the
  user on both, so don't add a chat question on top.
- A hook blocked or warned; ask mode, guards, index sync, bootstrap → load
  `hooks-guards` before reacting. It names the hook and what it wants instead.

## User-invoked

`/commit`, `/doctor`, `/optimize`, `/usage`, `/test-browser` are skills with
`disable-model-invocation: true`; `/ask`, `/ask-off` are plain commands in
`claude/commands/`. Both kinds are user-invoked only, never self-triggered —
offer one in a line when it fits: `/doctor` when the harness itself misbehaves
(loops, repeated refusals, dead index, expired provider auth), `/optimize` and
`/usage` for spend and settings. `/test-browser` is never offered — the user
asks for it.
