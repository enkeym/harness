# OpenCode

Shared rules: `rules/core.md`, loaded through `instructions` in `opencode.json`.
Here only what exists in OpenCode alone.

## Tools

- MCP tools carry the server prefix: `tokensave_tokensave_context`,
  `ragsave_rag_search`. Rules and skills name them short (`tokensave_context`,
  `rag_search`) — prepend the prefix.
- Files: built-in `read`, `edit`, `write`; exact string outside the index:
  `grep` with `include`.
- The guard plugin (`plugin/tokensave-guard.js`, logic in
  `~/.ai-hooks/guard-core.mjs`) blocks built-in `read`/`grep`/`edit`/`write` and
  shell equivalents on indexed source files. Refused → tokensave `read`/`search`
  for reading, `str_replace`/`replace_symbol`/`insert_at` for editing; a new
  file is built-in `write`.

## Agents

- `@commit` runs the `git-flow` procedure in its own session; model and
  permissions are in `opencode/agent/commit.md`. User-invoked only — never
  delegate to it on your own.
- In the main session `git commit` and `git push` are gated by
  `permission.bash` — run them, don't add a chat question on top.

## Claude Code only

Denied here through `permission.skill`: `commit`, `doctor`, `optimize`,
`usage`, `hooks-guards`. Slash commands `/ask`, `/ask-off`, `/commit` do not
exist — use the `ask` agent. `/handoff` and `/test-browser` are thin commands in
`opencode/command/` that load the shared skill; `test-browser` asks before
loading and is never loaded or offered on your own.
