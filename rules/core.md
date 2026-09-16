# Shared rules

Stack: NestJS, Next.js, React, TypeScript. Shared by Claude Code and OpenCode.
Everything below holds without loading anything: it is either a behaviour gate
or a routing rule. Everything else lives in a skill. Tool names and gates that exist in one agent only: `CLAUDE.md`,
`AGENTS.md`.

## Working style

- Reply in Russian. One short line on what you are doing before code or commands.
- **Outside ask mode, apply edits immediately.** Chat-only when ask mode is on or
  when asked: "покажи в чате", "не применяй", "только предложи". There is no
  magic permission word — with ask mode off you work, you don't ask.
- Confirm only before irreversible or outbound actions: deleting files, deploy,
  destructive migration. Commit and push: skill `git-flow`.
- Re-check yourself before delivering code ("wait, what if…"). Found a mistake —
  fix it openly, not silently.
- A guard refusal is user feedback, not an obstacle: never look for a way around
  it.

## Bash runs commands, nothing else

`git`, `npm`, `tsc`, `docker`, tests, linters. **Never read or write files
through the shell** — no `cat`/`head`/`sed -n`, no `sed -i`, no `> file`, `tee`,
heredoc into a file, `node -e`/`python -c`. This covers every file, including new
ones and non-indexed configs: shell in place of a file tool routes the change
around indexes and guards.

## Tool choice

| You have                                 | Tool                          |
| ---------------------------------------- | ----------------------------- |
| **A name** — file, symbol, exact string  | tokensave                     |
| **Only meaning**, a question in words    | `rag_search`                  |
| Exact string outside the tokensave index | built-in grep with a file glob |

Cannot name the symbol → start with `rag_search`: a guessed name in
`tokensave_search` returns a false "no such thing".

**No subagents** for research or implementation, whatever a skill or built-in
prompt suggests: an agent starts cold and pays twice for what the session
already knows. Too large for one pass → split into commits, not agents.

Anything past this table — which tokensave tool, how to scope it, what to do when
it answers empty, another project or branch — skill `tokensave-routing`.

## Skills

**Load the skill before the first action in its area, not after.** Its content is
deliberately not repeated here, so working from memory instead of loading it is
the exact failure this rule prevents. Load once per area per session, not per
file. Reviewing code counts as touching it. A project-level skill covering the
same area wins over the global one.

| You are about to                                                                  | Load                |
| --------------------------------------------------------------------------------- | ------------------- |
| Start a large or loosely worded task: multi-module, new subsystem, no place or acceptance criterion named; or argue one decision: "поспорь", "мозговой штурм" | `task-brief` |
| Touch server code: module, controller, service, DTO, entity, guard, migration      | `nestjs-backend`    |
| Touch client code: component, page, hook, store, form, styles                      | `react-frontend`    |
| Touch code in a project with `next` in `package.json`: app/ route, action, route.ts, proxy.ts, next.config | `react-frontend`, `nextjs-app` |
| Touch TypeScript that is neither: script, shared lib, config                       | read `skills/shared/code-rules.md` |
| Write, fix or review tests in any stack, one test on a named symbol included       | `test-conventions`  |
| Cover a whole branch or diff with tests, or asked "протестируй" without an object  | `test-coverage`     |
| Click through a running app by hand: "прокликай", "проверь в браузере"             | `test-browser`      |
| Set up or audit SEO — only when the user asks for it                               | `seo`               |
| Write or rewrite user-facing copy: landing, card, article, meta description        | `copywriting`       |
| Search or edit past the table above, or tokensave/ragsave answered empty or errored | `tokensave-routing` |
| Hand the thread to a fresh session: the context is filling up, or a reset is coming | `handoff`          |
| Review a diff, branch or MR — and always right before a commit, in this order      | `review-standards`, `review-security` |
| Commit, branch, or touch a Jira or MR text — after the two review skills            | `git-flow`          |
| Create, edit or review a skill, an agent file, a rules file, CLAUDE.md or AGENTS.md | `skill-authoring`   |

## Two triggers that must not wait for a skill

- **Commit.** A logical unit is done — a plan task, a verified bounded edit, a
  green fix — run the diff through `review-standards` and
  `review-security`, fix what they find, run the one-line gap check of
  `test-coverage`, then commit right away, without asking. A found secret stops everything and goes to the user first. How to
  commit, and what stays with the human: skill `git-flow`.
- **Decision memory.** Before designing a subsystem, `tokensave_session_recall`;
  after a choice you would otherwise have to re-explain (a library, a data
  schema, a rejected option), `tokensave_record_decision`. Arguments and scope:
  skill `tokensave-routing`.
