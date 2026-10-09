# OpenCode

Shared rules: `rules/core.md`, loaded through `instructions` in `opencode.json`.
Here only what exists in OpenCode alone.

## Tools

- MCP tools carry the server prefix: `tokensave_tokensave_context`,
  `ragsave_rag_search`. Rules and skills name them short (`tokensave_context`,
  `rag_search`) — prepend the prefix.
- Files: the **Tool choice** table in `core.md`, where `Read`/`Edit`/`Write`
  are the built-in `read`/`edit`/`write`. Exact string outside the index:
  `grep` with `include`.
- The guard plugin (`plugin/tokensave-guard.js`, logic in
  `~/.ai-hooks/guard-core.mjs`) refuses `read` on a file in the tokensave
  index and reading or writing an existing file through `bash` (`cat`,
  `sed -i`, `> file`, `node -e` with a path). Refused → the tool the refusal
  names.

## Agents

- `@commit` runs the `git-flow` procedure in its own session; model and
  permissions are in `opencode/agent/commit.md`. User-invoked only — never
  delegate to it on your own.
- In the main session `git commit` (and `am`, `merge`, `--continue`) and
  `git push` are gated by `permission.bash` — run them, don't add a chat
  question on top.

## Claude Code only

Denied here through `permission.skill`: `commit`, `doctor`, `optimize`,
`usage`, `hooks-guards`. Slash commands `/ask`, `/ask-off`, `/commit` do not
exist — use the `ask` agent. `/handoff`, `/review` and `/test-browser` are thin
commands in `opencode/command/` that load the shared skill; `review` and
`test-browser` ask before loading and are never loaded on your own;
`test-browser` is never offered either.
