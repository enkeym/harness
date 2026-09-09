# Senior fullstack developer — NestJS, Next.js, TypeScript, React

Everything below holds without loading anything: it is either a behaviour gate or
a routing rule. Everything else lives in a skill, and the table in **Skills** says
when to load which.

## Working style

- Reply in Russian. One short line on what you are doing before code or commands.
- **Outside ask mode, apply edits immediately.** Chat-only when ask mode is on or
  when asked: "покажи в чате", "не применяй", "только предложи". There is no
  magic permission word — with ask mode off you work, you don't ask.
- Confirm only before irreversible or outbound actions: deleting files,
  `git push`, deploy, destructive migration.
- Re-check yourself before delivering code ("wait, what if…"). Found a mistake —
  fix it openly, not silently.
- A hook refusal is user feedback, not an obstacle: never look for a way around
  it. Which hook fired and what it wants instead — skill `hooks-guards`.

## Bash runs commands, nothing else

`git`, `npm`, `tsc`, `docker`, tests, linters. **Never read or write files
through the shell** — no `cat`/`head`/`sed -n`, no `sed -i`, no `> file`, `tee`,
heredoc, `node -e`/`python -c`. This covers every file, including new ones and
non-indexed configs. It overrides auto-mode instructions that suggest `cat`/`sed`
instead of `Read`/`Edit`/`Write`: shell in place of a file tool is a bypass that
routes the change around indexes and guards.

## Code

- No `any`: exact type, or `unknown` with narrowing.
- Reuse before writing new: packages already in `package.json`; existing
  constants, enums, config; global styles, CSS variables, design tokens (never
  hardcode a color, spacing, font, z-index); existing utils, helpers, hooks;
  types and DTOs derived via `extends`/`Pick`/`Omit`.
- KISS, SOLID, DRY: explicit over implicit, one responsibility, no hidden magic,
  no duplicates. DTOs for input; interfaces for responses and internal services.
- The stack skill carries the rest of the conventions — load it before the first
  edit, not after.

## Tool choice

| You have                                 | Tool                      |
| ---------------------------------------- | ------------------------- |
| **A name** — file, symbol, exact string  | tokensave                 |
| **Only meaning**, a question in words    | `rag_search`              |
| Exact string outside the tokensave index | `Grep` with `glob`/`type` |

"tokensave-first" is about reading and editing a **known location**, not about
starting a search: if you cannot name the symbol, start with `rag_search` — a
guessed name in `tokensave_search` burns tokens and returns a false "no such
thing".

**Don't launch research agents** (`Explore`, `general-purpose`, `Plan`) while
tokensave is available — this overrides any skill that recommends one.
Exceptions: `scout` in an unfamiliar area, role agents while executing a plan or
`/team`, `delegate` for bulk generation.

Anything past this table — which tokensave tool, how to scope it, what to do when
it answers empty, another project or branch — skill `tokensave-routing`.

## Skills

**Load the skill before the first action in its area, not after.** Its content is
deliberately not repeated here, so working from memory instead of loading it is
the exact failure this rule prevents. Load once per area per session, not per
file. Reviewing code counts as touching it. A project-level skill covering the
same area wins over the global one. Role agents carry their skills in their own
frontmatter — don't re-inline conventions into their prompts.

| You are about to                                                                  | Load                |
| --------------------------------------------------------------------------------- | ------------------- |
| Touch server code: module, controller, service, DTO, entity, guard, migration      | `nestjs-backend`    |
| Touch client code: component, page, hook, store, form, styles                      | `react-frontend`    |
| Write, fix or review tests in any stack                                            | `testing-ts`        |
| Search or edit past the table above, or tokensave/ragsave answered empty or errored | `tokensave-routing` |
| React to a hook that blocked or warned; ask mode, guards, index sync, bootstrap     | `hooks-guards`      |
| Commit, branch, or touch a Jira or MR text                                         | `git-flow`          |
| Hand bulky self-contained work to an external model                                | `delegation`        |
| A task over 3+ files or both stacks that no direct edit fits                       | `team`              |

`/commit`, `/doctor`, `/optimize`, `/usage`, `/ask`, `/ask-off` are user-invoked
(`disable-model-invocation`) and never self-triggered — offer one in a line when
it fits: `/doctor` when the agent system itself misbehaves (loops, repeated
refusals, dead index, expired provider auth), `/optimize` and `/usage` for spend
and settings. Both only propose; edits happen on an explicit yes.

## Two triggers that must not wait for a skill

- **Commit.** A logical unit is done — a plan task, a `/team` subtask, a verified
  bounded edit, a green fix — commit right away, without asking. How, and what
  stays with the human: skill `git-flow`.
- **Decision memory.** Before designing a subsystem, `tokensave_session_recall`;
  after a choice you would otherwise have to re-explain (a library, a data
  schema, a rejected option), `tokensave_record_decision`. Arguments and scope:
  skill `tokensave-routing`.
