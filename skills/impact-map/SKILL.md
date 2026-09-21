---
name: impact-map
description: "Creates the first implicit-links map in a project indexed by tokensave — picks docs/links/ or .claude/links/ by repository authorship, writes the INDEX.md skeleton, seeds it with the links the graph cannot see (events, cache and storage keys, feature flags, cron and webhook entry points, cross-boundary contracts, migration order) found through tokensave_search and rag_search, and validates every path:symbol with check-impact-map.mjs. A project that already has a map only gets the checker run; a project without .tokensave/ gets no map. User-invoked as /impact-map."
disable-model-invocation: true
allowed-tools: Bash(node /home/enkeym/.ai-hooks/bin/init-impact-map.mjs:*), Bash(node /home/enkeym/.ai-hooks/bin/check-impact-map.mjs:*), Read, Write, mcp__tokensave__tokensave_search, mcp__ragsave__rag_search
argument-hint: "[project path]"
---

# /impact-map

Seed the map once; after that it grows one line per impact pass, never by
another scan. Where it lives, the index-plus-entity shape, the line format and
what qualifies as a link: [../shared/impact-map.md](../shared/impact-map.md) —
this skill adds only the first run. Project = `$ARGUMENTS`; empty → cwd.

## Steps

1. `rag_search` for a map under another name — "неявные связи", "скрытые
   связи", "тронул X → обнови Y" — across `CLAUDE.md`, `docs/`, ADR folders.
   Found → stop and name the file: a second place for the same links is worse
   than none.
2. `node ~/.ai-hooks/bin/init-impact-map.mjs <project>`. Its line decides:
   - `нет .tokensave` → report it, done. Without the graph the impact pass is
     `grep -rn --include`, not a map.
   - `уже есть` → step 5 only.
   - `плоская` → stop. Splitting a flat map is an edit with the user, not a scan.
   - `создана` → steps 3–5.
3. Discovery — one `tokensave_search` with `literal: true` per row, scoped with
   `path_include` to the source tree; `.env.example` and config files through
   `rag_search`. A row with no hits gets no section and no file.

   | Kind | Search | Line needs |
   | --- | --- | --- |
   | События, очереди | `@OnEvent(`, `.emit(`, `@Process(`, `@Processor(`, `.add(` on a queue | emitter → every handler, by the string name |
   | Ключи хранилищ | `localStorage.`, `sessionStorage.`, `revalidateTag(`, `cacheTag(`, `queryKey`, Redis `set(`/`get(` | writer → every reader of the same key |
   | Флаги и переключатели | names from `.env.example` → `process.env.<NAME>`, config getters | the flag → every branch that reads it |
   | Расписание и внешние входы | `@Cron(`, `@Interval(`, routes named `webhook`, `callback`, provider SDK handlers | trigger → the code nothing else calls |
   | Контракты через границу | response keys, query params, form field names read on both sides outside a shared type | server symbol ↔ client symbol |
   | Порядок миграций | migration files that reference another migration's table or column | earlier → later |

4. Write the entity files with `Write` (tokensave creates no files) — one per
   entity the diff would start from, a section per kind, sides as exact
   `path:symbol`, the consequence in the same line. A hit that names only one
   side is not a link: drop it, don't guess the other side. Then one index
   line per entity file.
5. `node ~/.ai-hooks/bin/check-impact-map.mjs <project>`. Every reported line
   is fixed or deleted before the report — a seed with a broken reference
   teaches the next pass to distrust the map.

## Output

```
карта: <docs/links | .claude/links> — <создана | уже была>
- <сущность> — <n строк> — <виды связей>
проверка: <строка чекера>
```

No entities = `связей, которых граф не видит, не нашёл — карта пустая,
пополняется в impact-проходе`. Never pad it: an empty map that is honest
beats a section of guesses.
