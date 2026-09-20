# Impact map — what the graph cannot see

Read by `review-standards` and `test-coverage` before the impact pass, and by
`task-brief` when the task touches a listed entity. The graph
(`tokensave_impact`, `callers`, `callees`, `field_sites`, `affected`) answers
"who calls this". This file answers the rest: links that exist at runtime but
not in any call edge, and that a change silently breaks. What memory may
answer instead: [memory-hygiene.md](memory-hygiene.md).

Only in a project with `.tokensave/`. Without the graph there is nothing for a
map to complement — do the impact pass with `grep -rn --include` over the
changed names and say so in one line.

## Where it lives

The map is committed, so the repository decides who reads it:

- **Your own repository** (every commit is yours) → `docs/links/`.
- **Shared repository** (other authors in `git log`) → `.claude/links/`,
  which the global gitignore already covers. Personal notes about someone
  else's codebase stay out of their history; a new top-level file there is the
  team's decision, not yours.
- The project already keeps a map under another name — sections of
  `CLAUDE.md`, `docs/architecture.md`, an ADR folder, another agent's rules →
  that is the map. Add the line there, in the format that file already uses.
  Never create a second place for the same link.

## Shape: an index plus one file per entity

One flat file grows past the context it was meant to save. Split by **entity**
(the module you touch), never by kind of link — the pass starts from what the
diff touched:

```
docs/links/INDEX.md     — one line per entity: name → file → trigger words
docs/links/<entity>.md  — the links of that entity
```

- `INDEX.md` is read every pass and stays ≤30 lines: entity, file, the words
  that should send you there. No link content in it — a detailed index is read
  instead of the file and saves nothing.
- An entity file stays ≤80 lines. Past that, the entity has sub-entities: give
  each its own file and one index line.
- A link between two entities lives in the file of the one a change starts
  from, and the other entity's file names it in one line.
- Index line format: `- <entity> — `<file>` — триггеры: <слова>`.

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
how something works, history, status of a migration, plans, measurements,
decisions (those go to `tokensave_record_decision`).

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

- Every side is `path:symbol`, exact — the checker resolves them and a line
  that does not resolve is reported as broken.
- The consequence in the same line: what breaks if one side changes alone.
- Russian, matching the rest of the project's docs.

## Keeping it honest

- Add a line the moment the impact pass finds a link the graph missed — not
  later, and only that line.
- Touched a link this change? Re-read its line first; wrong → fix it in the
  same commit as the code.
- Deleted the last side of a link → delete the line, and the entity file with
  its index line when it was the last one. Never leave a section saying a rule
  no longer applies: a tombstone costs context every pass, and git history
  already keeps it.
- `node ~/.ai-hooks/bin/check-impact-map.mjs <project>` resolves every
  `path:symbol` and the index against the working tree. Run it in the impact
  pass before the review skills; a broken line is a deleted module whose line
  outlived it.
