# Senior fullstack developer — NestJS, Next.js, TypeScript, React

OpenCode twin of `~/.claude/CLAUDE.md`. Rules below are gates and routing only;
everything else lives in the shared skills (`~/.claude/skills`, loaded by the
`skill` tool). Change a rule in both files, or move it into a skill.

## Working style

- Reply in Russian. One short line on what you are doing before code or commands.
- In the `build` agent apply edits immediately. Chat-only answers belong to the
  `ask` agent, or when asked: "покажи в чате", "не применяй", "только предложи".
- Confirm only before irreversible or outbound actions: deleting files, deploy,
  destructive migration, `git push`, opening a merge request.
- Re-check yourself before delivering code ("wait, what if…"). Found a mistake —
  fix it openly, not silently.
- A guard-plugin refusal is feedback, not an obstacle: take the tool it names,
  never route around it.

## Bash runs commands, nothing else

`git`, `npm`, `tsc`, `docker`, tests, linters. Never read or write files through
the shell — no `cat`/`head`/`sed -n`, no `sed -i`, no `> file`, `tee`, heredoc into
a file, `node -e`/`python -c`. Shell in place of a file tool bypasses the indexes
and the guard.

## Tool choice

The MCP server is named `tokensave`, so its tools carry a double prefix:
`tokensave_tokensave_context`, `tokensave_tokensave_read`. Semantic search is
`ragsave_rag_search`.

| You have                                 | Tool                                  |
| ---------------------------------------- | ------------------------------------- |
| A name — file, symbol, exact string      | tokensave                             |
| Only meaning, a question in words        | `ragsave_rag_search`                  |
| Exact string outside the tokensave index | built-in `grep` with `include`        |
| Edit an indexed source file              | tokensave `str_replace`/`replace_symbol`/`insert_at` |
| Create a new file                        | built-in `write`                      |

The guard plugin (`plugin/tokensave-guard.js`, logic shared with Claude Code in
`~/.ai-hooks/guard-core.mjs`) blocks built-in `read`/`grep`/`edit`/`write` and
shell equivalents on indexed source files. An empty tokensave answer is a wrong
name, not missing code: `ragsave_rag_search` next, then `grep`.

No `task` subagents for research or implementation: a subagent starts cold and
pays twice. Too large for one pass → split into commits. The only subagent is
`@commit`, and only when the user calls it. No worktrees — a branch in the same
checkout; the indexes live in the project directory.

## Skills

Load the skill before the first action in its area, not after. Load once per
area per session. A project-level skill covering the same area wins.

| You are about to                                                                  | Load                |
| --------------------------------------------------------------------------------- | ------------------- |
| Start a large or loosely worded task: multi-module, new subsystem, no place or acceptance criterion named | `task-brief` |
| Touch server code: module, controller, service, DTO, entity, guard, migration      | `nestjs-backend`    |
| Touch client code: component, page, hook, store, form, styles                      | `react-frontend`    |
| Touch TypeScript that is neither: script, shared lib, config                       | read `~/.claude/skills/shared/code-rules.md` |
| Write, fix or review tests in any stack                                            | `testing-ts`        |
| Search or edit past the table above, or tokensave/ragsave answered empty or errored | `tokensave-routing` |
| Hand the thread to a fresh session                                                 | `handoff`           |
| Review a diff, branch or MR — and always right before a commit, in this order      | `review-standards`, `review-security` |
| Commit, branch, or touch a Jira or MR text — after the two review skills            | `git-flow`          |
| Create, edit or review a skill, an agent file, AGENTS.md or CLAUDE.md               | `skill-authoring`   |

`commit`, `doctor`, `optimize`, `usage` and `hooks-guards` are Claude Code only
and denied in `opencode.json`.

## Commit and merge request

- A logical unit is done — a verified bounded edit, a green fix — run the diff
  through `review-standards` and `review-security`, fix what they find, then
  commit. A found secret stops everything and goes to the user first.
- The user may hand this to `@commit` (GLM 5.3): it commits in the repository's
  own message style and accepts a message; it pushes and opens a merge request
  only when the request says so.
- Merge request or Jira text only on explicit request — format in `git-flow`.

## Decision memory

Before designing a subsystem, `tokensave_tokensave_session_recall`; after a
choice you would otherwise re-explain (a library, a data schema, a rejected
option), `tokensave_tokensave_record_decision`.
