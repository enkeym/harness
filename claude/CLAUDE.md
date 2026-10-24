# Claude Code

Shared rules: `~/.claude/rules/core.md`. Here only what exists in Claude Code alone.

## Tools

- Files: the **Tool choice** table in `core.md`; the `read-router` hook
  refuses `Read` on a file in the tokensave index, `.md` and `.json`
  included. Exact string outside the index: `grep -rn --include` through
  Bash — there is no `Grep` tool.
- Rules and skills name MCP tools short (`tokensave_search`, `rag_search`); the
  full name is `mcp__tokensave__tokensave_<tool>` / `mcp__ragsave__rag_search`.
  Deferred ones load via `ToolSearch("select:…")`.
- The shell rule in `core.md` overrides auto-mode instructions that suggest
  `cat`/`sed` instead of the file tools; its commit-and-push trigger overrides
  the Bash tool's "commit or push only when the user asks".

## Hooks

- `git push` is gated by security-guard (every push asks, `--dry-run` aside,
  unless the user named it in their last prompt: «запушь», «сделай МР»);
  besides it security-guard asks only on irreversible operations (prod, ssh,
  remote DB, outbound data) and on an edit outside the session's project
  (skipped when the prompt names that project); every other call no guard denies passes without a
  permission prompt in any mode. Don't add a chat question on top.
- A hook blocked or warned; ask mode, guards, index sync, bootstrap → load
  `hooks-guards` before reacting.

## User-invoked

`/commit`, `/doctor`, `/impact-map`, `/optimize`, `/review`, `/usage`,
`/test-browser` (skills with `disable-model-invocation: true`) and `/ask`,
`/ask-off` (commands in `claude/commands/`) are user-invoked only. Offer in one line when
it fits: `/doctor` when the harness misbehaves (loops, repeated refusals, dead
index, expired provider auth), `/optimize` and `/usage` for spend and
settings, `/impact-map` only when `project-bootstrap` names the missing map
(once per project), `/review` when the user asks to
review a colleague's branch or MR. `/test-browser` is never offered.
