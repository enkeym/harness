# Shared rules

Stack: NestJS, Next.js, React, TypeScript. Shared by Claude Code and OpenCode.
Only behaviour gates and routing rules here; procedure lives in skills.
Agent-specific tools and gates: `CLAUDE.md`, `AGENTS.md`.

## Working style

- Reply in Russian. One short line on what you are doing before code or commands.
- Ask mode off → apply edits immediately. Chat-only when ask mode is on or the
  user says "покажи в чате", "не применяй", "только предложи".
- Confirm only before: deleting files, deploy, destructive migration, force
  push, merge into a protected branch. Commit and push need no confirmation.
- Re-check the diff before delivering. Found a mistake — fix it openly.
- A guard refusal is final: never route around it.

## Project facts outrank skills

Base branch, ticket format, commit style, remote, scripts, commit/push
restrictions — from the project, in this order:

1. Project memory and the project's `CLAUDE.md` / `AGENTS.md`.
2. The repository: git, `package.json`, configs — via `skills/shared/project-facts.md`.
3. A skill's default.

A restriction applies only to the project whose memory or rules file states it.
A skill line naming another project's value is a defect: fix the skill.

## Bash runs commands, nothing else

`git`, `npm`, `tsc`, `docker`, tests, linters. No file reads or writes through
the shell: no `cat`/`head`/`sed -n`, `sed -i`, `> file`, `tee`, heredoc into a
file, `node -e`/`python -c` — including new files and non-indexed configs.

## Tool choice

| You have                                 | Tool                          |
| ---------------------------------------- | ----------------------------- |
| A name — file, symbol, exact string      | tokensave                     |
| Only meaning, a question in words        | `rag_search`                  |
| Exact string outside the tokensave index | built-in grep with a file glob |

Cannot name the symbol → `rag_search` first. No subagents for research or
implementation; too large for one pass → split into commits. Which tokensave
tool, scoping, empty answers, another project or branch: skill `tokensave-routing`.

## Skills

Load the skill before the first action in its area, once per area per session.
Reviewing code counts as touching it. A project-level skill for the same area
wins over the global one. Quoted phrases in the table are examples of how the
user asks, not the only trigger.

| You are about to                                                                  | Load                |
| --------------------------------------------------------------------------------- | ------------------- |
| Start a large or loosely worded task: multi-module, new subsystem, no place or acceptance criterion named; or argue one decision: "поспорь", "мозговой штурм" | `task-brief` |
| Touch server code: module, controller, service, DTO, entity, guard, migration      | `nestjs-backend`    |
| Touch client code: component, page, hook, store, form, styles                      | `react-frontend`    |
| Touch code in a project with `next` in `package.json`: app/ route, action, route.ts, proxy.ts, next.config | `react-frontend`, `nextjs-app` |
| Touch TypeScript that is neither: script, shared lib, config                       | read `skills/shared/code-rules.md` |
| Write, fix or review tests in any stack, one test on a named symbol included       | `test-conventions`  |
| Cover a whole branch or diff with tests, test a change with no object named, or prepare an MR | `test-coverage` |
| Set up or audit SEO — only when the user asks for it                               | `seo`               |
| Write or rewrite user-facing copy: landing, card, article, meta description        | `copywriting`       |
| Search or edit past the table above, or tokensave/ragsave answered empty or errored | `tokensave-routing` |
| Hand the thread to a fresh session: the context is filling up, or a reset is coming | `handoff`          |
| Review a diff, branch or MR — and always right before a commit, in this order      | `review-standards`, `review-security` |
| Commit, branch, or touch a Jira or MR text — after the two review skills; an MR after `test-coverage` too | `git-flow` |
| Create, edit or review a skill, an agent file, a rules file, CLAUDE.md or AGENTS.md | `skill-authoring`   |

## Three triggers that must not wait for a skill

- **Commit and push.** A logical unit is done (a plan task, a verified edit, a
  green fix) → impact pass, `review-standards`, `review-security`, fix
  findings, commit, push — without asking. Only a restriction in the project's
  own memory or rules file stops a step; then do the rest and report the
  skipped step in one line. A found secret stops everything. Procedure: skill
  `git-flow`.
- **Impact before the review skills.** Every symbol whose behaviour the diff
  changes goes through `tokensave_impact`/`callers` and the project's
  `docs/implicit-links.md`; each hit ends as unaffected, fixed, or covered by a
  test. Green tests on the changed symbol prove nothing about its consumers.
  Format and what belongs in the file: `skills/shared/impact-map.md`.
- **Decision memory.** Before designing a subsystem, `tokensave_session_recall`;
  after a choice you would otherwise re-explain (library, schema, rejected
  option), `tokensave_record_decision`. Scope: skill `tokensave-routing`.
