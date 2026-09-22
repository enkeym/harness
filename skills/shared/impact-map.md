# Impact map — what the graph cannot see

Read by `review-standards` and `test-coverage` before the impact pass, and by
`task-brief` when the task touches a listed domain. The graph
(`tokensave_impact`, `callers`, `callees`, `affected`) answers
"who calls this". This file answers the rest: links that exist at runtime but
not in any call edge, and that a change silently breaks. What memory may
answer instead: [memory-hygiene.md](memory-hygiene.md).

Only in a project with an index — `.tokensave/` or `.ragsave/rag.db`: the
candidates come from it. Without one, do the impact pass with
`grep -rn --include` over the changed names and say so in one line.

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
- No map at all → `/impact-map` creates and seeds it (user-invoked). Until
  then, a link the pass finds still gets its line: the first line creates the
  file.

## Shape: an index plus one file per domain

One flat file grows past the context it was meant to save. Split by **domain**
(the feature a diff starts in — `tracking`, `auth`, `billing`), server and
client sides in the same file; never by kind of link — a kind file makes one
change open four files:

```
docs/links/INDEX.md          — one line per domain: name → file → one phrase
docs/links/<domain>.md       — `paths:` frontmatter, then the links of that domain
docs/links/<domain>/<sub>.md — only once <domain>.md passes 80 lines
```

- `INDEX.md` is read every pass and stays ≤30 lines. Line format:
  `- <домен> — `<файл>` — <одна фраза>`; a sub-file is listed as
  `tracking/rls.md`. No link content and no trigger words in it — routing is
  the job of `paths:`, and a detailed index is read instead of the file.
- A domain file stays ≤80 lines. Past that, split it into a directory of
  sub-domains, each with its own frontmatter and index line; the parent file
  goes away.
- A link between two domains lives in the file of the one a change starts
  from, and the other domain's file names it in one line.

## `paths:` — how a domain file reaches the model

Every domain file opens with the `.claude/rules` frontmatter:

```markdown
---
paths:
  - "src/tracking/**"
  - "client/src/features/tracking/**"
---
```

- The harness hook `links-context.mjs` injects the file once per session the
  first time a read or edit tool touches a matching path — native path-scoped
  rules fire on `Read` only, never on `tokensave_read`, which the router
  forces for indexed files. `INDEX.md` stays for the impact pass and OpenCode.
- Globs are project-relative in `path.matchesGlob` syntax; each one matches
  at least one file in the working tree — the checker reports the rest. A
  file without `paths:` is reached only through the index.
- List the directories a change to the domain starts in, nothing wider: a glob
  over `src/**` fires on every edit and the file stops being read.

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

One line per link, newest at the bottom of its section. A domain file:

```markdown
---
paths:
  - "src/orders/**"
  - "src/<feature>/**"
---

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
  that does not resolve is reported as broken. `path` alone only when the side
  came from `git grep` and no symbol encloses it.
- The consequence in the same line: what breaks if one side changes alone.
- Russian, matching the rest of the project's docs.

## Keeping it honest

- Add a line the moment the impact pass finds a link the graph missed — not
  later, and only that line.
- Touched a link this change? Re-read its line first; wrong → fix it in the
  same commit as the code.
- Moved or renamed a directory → the glob in `paths:` moves in the same
  commit; the checker reports a glob that matches nothing.
- Deleted the last side of a link → delete the line, and the domain file with
  its index line when it was the last one. Never leave a section saying a rule
  no longer applies: a tombstone costs context every pass, and git history
  already keeps it.
- `node ~/.ai-hooks/bin/check-impact-map.mjs <project>` resolves every
  `path:symbol`, every `paths:` glob and the index against the working tree.
  Run it in the impact pass before the review skills; a broken line is a
  deleted module whose line outlived it.
