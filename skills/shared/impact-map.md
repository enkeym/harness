# Impact map — what the graph cannot see

Read by `review-standards` and `test-coverage` before the impact pass, and by
`task-brief` when the task touches a listed name. The graph
(`tokensave_impact`, `callers`, `callees`, `field_sites`, `affected`) answers
"who calls this". This file answers the rest: links that exist at runtime but
not in any call edge, and that a change silently breaks.

Lives in `<project>/docs/implicit-links.md`, or `<project>/.claude/implicit-links.md`
where the project has no `docs/`. One file per project, never a directory.
Unlike the tokensave graph and its decisions (`.tokensave/`, git-ignored, local
to this machine), this file is committed and read by the whole team.

## A project that already keeps one

The project's own convention wins — `rules/core.md`, *Project facts outrank
skills*. Look before creating anything:

- An existing map under another name is the map: sections of `CLAUDE.md` or
  `AGENTS.md`, `docs/architecture.md`, an ADR folder, a spec directory, or
  another agent's rules (`.cursor/rules`, `.github/copilot-instructions.md`).
  Add the line there, in the format that file already uses.
- Never create a second place for the same link. Two maps disagree within a
  month, and the stale one is the one that gets read.
- A shared repository: a new file in it is the team's decision, not yours.
  Nothing to extend → name the candidate places in one line and let the user
  choose.
- A found link contradicting what the map says → report it in one line; fix
  the team's line only with the change that proves it wrong.

## What goes in

A line earns its place only if a name search cannot settle the link. Six kinds:

- **Events and queues** — emitter and handlers found by a string name:
  `order.paid`, a job name, a socket channel, a NestJS `@OnEvent`.
- **Cache and storage keys** — who writes and who reads `localStorage`,
  Redis, a query key, a revalidation tag.
- **Feature flags and config switches** — the flag and every branch that reads it.
- **Scheduled and external entry points** — cron, webhook, provider callback:
  what triggers the code when no caller does.
- **Contracts across the boundary** — field names a client and a server agree
  on outside a shared type: response keys, query params, form field names.
- **Migration order** — a migration that must land before or after another, or
  before a deploy step.

Out: anything the graph already returns, module structure, architecture notes,
how something works, history, decisions (those go to `tokensave_record_decision`).

## Line format

One line per link, newest at the bottom of its section:

```markdown
## События
- `order.paid` — эмит `src/orders/orders.service.ts:markPaid` → слушают
  `src/mail/mail.listener.ts:onPaid`, `src/stats/stats.listener.ts:onPaid`.
  Слушатели полагаются на `order.items` уже загруженными.

## Ключи хранилища
- `<feature>:<entity>:draft` (localStorage) — пишет
  `src/<feature>/Form.tsx:saveDraft`, читает
  `src/<feature>/useDraft.ts:restore`. Формат менять только вместе.
```

- Exact paths and symbols, as in `Карта` of a handoff block.
- The consequence in the same line: what breaks if one side changes alone.
- Russian, matching the rest of the project's docs.

## Keeping it honest

- Add a line the moment the impact pass finds a link the graph missed — not
  later, and only that line.
- Touched a link this change? Re-read its line first; wrong → fix it in the
  same commit as the code.
- Deleted the last side of a link → delete the line. A stale line costs more
  than a missing one: it sends the next session to a symbol that no longer exists.
- Growing past ~100 lines means kinds are creeping in that the graph covers —
  cut those, don't split the file.
