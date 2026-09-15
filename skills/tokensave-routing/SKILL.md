---
name: tokensave-routing
description: Which tokensave or ragsave tool to call for reading, searching, editing, impact analysis and decision memory; how to scope a call cheaply; what to do when one answers empty or errors; how to query another project or branch. Load before a non-trivial search or edit in an indexed project, when a tokensave or rag_search call comes back empty or broken, for callers/impact/dead-code questions, or when the answer may live outside code (docs, json/yaml, migrations, SQL, CI, .env.example).
---

# tokensave and ragsave routing

CLAUDE.md picks the family (tokensave / `rag_search` / `Grep`); this picks the
tool inside it.

## tokensave — indexed files (`.md` included)

| Task                              | Tool                                                                  |
| --------------------------------- | --------------------------------------------------------------------- |
| Read a file or symbol             | `read`, `body`, `signature`                                           |
| Context around a known entry      | `context`                                                             |
| Symbol by name / text in code     | `search` (`literal:true` for text)                                    |
| Who calls it, what breaks         | `callers`, `callees`, `field_sites`, `impact`, `affected`             |
| Edit existing code                | `str_replace`, `multi_str_replace`, `replace_symbol`, `insert_at*`    |
| Create a new file                 | `Write` — tokensave doesn't create files                              |

Full name `mcp__tokensave__tokensave_<tool>`; load via `ToolSearch("select:…")`.
Arguments from the schema, not memory.

- Pass `seen_node_ids` from one `context` into `exclude_node_ids` of the next.
- Scope with `path_include`/`path_exclude` — a monorepo pulls in a foreign stack.
- Plain lookup → `search`, not `context`.
- `tokensave_status` shows freshness. Never run `init`/`sync`. Stale graph →
  say so in one line.
- Not applicable: no `.tokensave/`, or agent config paths (`.claude/`,
  `.opencode/`, `~/.ai-hooks/`) → `Read`/`Edit`/`Write`/`Grep`.
- Another project: `graph_root` (absolute) + `graph_branch`. Another branch of
  the served project: `branch_search`, `branch_diff`, `branch_list`.

## ragsave — all text files

`rag_search` goes **first** when: the question is how/where/why with no known
name; the answer may be outside code (`only_outside_tokensave: true`); the
task opens with "разберись", "найди, где", "объясни, как работает".
Not for structural questions (callers, impact).

## Empty or broken answer

- Empty = wrong name guess, not missing code. Ladder: `rag_search` → `Grep`/`Read`.
- Error (not indexed, DB busy, wrong branch) → one line, then plain tools.
  Don't repeat the identical call: the router lets the second through, so a
  second refusal is your own answer.
- Graph genuinely silent: DB is `.tokensave/branch-meta.json` (`db_file`) or
  `.tokensave/tokensave.db`; tables `nodes`, `edges`, `files`. Offer an issue at
  https://github.com/aovestdipaperino/tokensave — no proprietary code in it.

## Instead of a research agent

Cover a big area with scoped `tokensave_context` plus `rag_search`, one call
at a time.

## Decision memory

- `tokensave_record_decision` after approval: one-line decision + `reason`,
  `files`, `tags`.
