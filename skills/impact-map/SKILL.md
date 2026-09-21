---
name: impact-map
description: "Creates the first implicit-links map in a project indexed by tokensave or ragsave — picks docs/links/ or .claude/links/ by repository authorship, writes the INDEX.md skeleton, runs seed-impact-map.mjs in the background for the deterministic candidate list (events, cache and storage keys, feature flags, cron and webhook entry points, migration folders) plus rag_search for cross-boundary contracts, writes one file per domain with `paths:` frontmatter, and validates every path:symbol and glob with check-impact-map.mjs. A project that already has a map only gets the checker run, or with --reseed a printed list of candidates the map lacks; a project with neither .tokensave/ nor .ragsave/rag.db gets no map. User-invoked as /impact-map."
disable-model-invocation: true
allowed-tools: Bash(node /home/enkeym/.ai-hooks/bin/init-impact-map.mjs:*), Bash(node /home/enkeym/.ai-hooks/bin/seed-impact-map.mjs:*), Bash(node /home/enkeym/.ai-hooks/bin/check-impact-map.mjs:*), Read, Write, mcp__tokensave__tokensave_search, mcp__ragsave__rag_search
argument-hint: "[project path] [--reseed]"
---

# /impact-map

Seed the map once; after that it grows one line per impact pass, never by
another scan — `--reseed` is the one exception, and it only prints. Where the
map lives, the index-plus-domain shape, `paths:` frontmatter, the line format
and what qualifies as a link: [../shared/impact-map.md](../shared/impact-map.md)
— this skill adds only the first run. Project = `$ARGUMENTS` minus the flag;
empty → cwd.

## Steps

1. `rag_search` for a map under another name — "неявные связи", "скрытые
   связи", "тронул X → обнови Y" — across `CLAUDE.md`, `docs/`, ADR folders.
   Found → stop and name the file: a second place for the same links is worse
   than none.
2. `node ~/.ai-hooks/bin/init-impact-map.mjs <project>`. Its line decides:
   - `нет индекса` → report it, done. Without `.tokensave/` or `.ragsave/rag.db`
     the impact pass is `grep -rn --include`, not a map.
   - `уже есть` → step 5 only; with `--reseed` → steps 3 and 6.
   - `плоская` → stop. Splitting a flat map is an edit with the user, not a scan.
   - `создана` → steps 3–5.
3. `node ~/.ai-hooks/bin/seed-impact-map.mjs <project>` in the background
   (`run_in_background: true` in Claude Code; OpenCode waits) — ~2 minutes on
   a mid-size project. While it runs, list the domains from the feature
   folders on both sides of the tree (`src/<domain>`,
   `client/src/features/<domain>`) and draft one `paths:` list per domain.
   The output is the whole candidate list, one `path:symbol` per line with
   the literal it matched (`path` alone from `git grep` when tokensave is
   absent). No `tokensave_search` by hand for these kinds: its default limit
   hid two thirds of the events on the first run. Each section pairs
   differently:

   | Section | One line is | Its other side |
   | --- | --- | --- |
   | События и очереди | emitter or handler with the event string | the lines with the same string; `${prefix}_x` templates by prefix |
   | Ключи хранилищ | reader or writer with the key or its constant | the lines with the same key |
   | Флаги и переключатели | one read of `process.env.X` / `import.meta.env.X` / a config getter | every other read of `X`; the header lists the names from `.env.example` |
   | Расписание и внешние входы | `@Cron`/`@Interval`/webhook handler | none needed — the trigger → its handler is the link |
   | Порядок миграций | folder, count, last file | migrations naming another migration's table: `rag_search` by table name |

   - `не влезло в ответ: <query> в <file>` → `tokensave_search` with
     `literal: true`, `path_include: [<file>]`, `limit: 500`, that file only.
   - Cross-boundary contracts (response keys, query params, form field names
     read on both sides outside a shared type) the script cannot see:
     `rag_search` by the field name, both trees.
   - A section absent from the output gets no section in the map; a name from
     `.env.example` with no read in the output is not a link.
4. Write the domain files with `Write` (tokensave creates no files) — one per
   domain a diff would start in, both sides of the boundary in the same file,
   `paths:` frontmatter first, then a section per kind, sides as exact
   `path:symbol`, the consequence in the same line. A candidate belongs to the
   domain of the side a change starts from; a hit that names only one side is
   not a link: drop it, don't guess the other side. Then one index line per
   domain file, no trigger words.
5. `node ~/.ai-hooks/bin/check-impact-map.mjs <project>`. Every reported line
   is fixed or deleted before the report — a seed with a broken reference
   teaches the next pass to distrust the map.
6. `--reseed` only: match every candidate against the map by `path:symbol`
   and by the literal; print the ones the map lacks, paired, in the map's line
   format, under the domain file each belongs to. Write nothing — the impact
   passes have already judged what is in the map, and a rewrite would undo
   those calls; the user picks which lines go in.

## Output

```
карта: <docs/links | .claude/links> — <создана | уже была>
- <домен> — <n строк> — <виды связей> — paths: <глобы>
проверка: <строка чекера>
```

`--reseed`:

```
карта: <docs/links | .claude/links> — уже была, кандидатов вне карты: <n>
<файл домена>:
- <строка в формате карты>
```

No domains = `связей, которых граф не видит, не нашёл — карта пустая,
пополняется в impact-проходе`. Never pad it: an empty map that is honest
beats a section of guesses.
