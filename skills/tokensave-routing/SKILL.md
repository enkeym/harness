---
name: tokensave-routing
description: "Which tokensave or ragsave tool answers a given question — symbol lookup, callers and impact, editing, decision memory, search outside code — how to scope a call cheaply, what an empty or broken answer means, and how to query another project. Load before a non-trivial search or edit in an indexed project, when a tokensave or rag_search call comes back empty or broken, for callers/impact/dead-code questions, or when the answer may live outside code (docs, json/yaml, migrations, SQL, CI, .env.example)."
---

# tokensave and ragsave routing

`rules/core.md` picks the family; this picks the tool inside it and says what
to do when it answers nothing. Full tool names: `CLAUDE.md` or `AGENTS.md`.
Built-in `Read`, `Edit`, `Write`, grep take what the index cannot: a new
file, a path outside the index, a string `search` missed.

## Tool by question

| Question                              | Tool                                                          |
| ------------------------------------- | ------------------------------------------------------------- |
| Symbol by name; text in code          | `search` (`literal: true` for text)                           |
| A file by name or mask                | `files` — not `find`/`ls` through Bash                        |
| A symbol's body or signature          | `body`, `signature`                                           |
| Context around a known entry          | `context` — plain lookup is `search`, not `context`           |
| Who calls it, what breaks             | `callers`, `callees`, `impact`, `affected`                    |
| Where a field is read or written      | `search` `literal: true` on `.field`                          |
| Edit a symbol                         | `str_replace`, `multi_str_replace`, `replace_symbol`, `insert_at*` |
| How/where/why with no name; docs, configs, migrations, CI | `rag_search` (`only_outside_tokensave: true` when the answer is not code) |
| Decision after approval               | `record_decision`: one line + `reason`, `files`, `tags`       |

- Arguments from the schema, not memory. Pass `seen_node_ids` from one
  `context` into `exclude_node_ids` of the next.
- Scope with `path_include`/`path_exclude` — a monorepo pulls in a foreign
  stack. A big area: several scoped `context` calls plus `rag_search`, not a
  subagent.
- Not indexed (no `.tokensave/`) or agent config paths (`.claude/`,
  `.opencode/`, `~/.ai-hooks/`) → built-in tools. `tokensave init` is the
  user's call — name it, don't run it.
- Another project: `graph_root` (absolute path).

## Empty or broken answer

- Empty = wrong name guess, not missing code. Ladder: `rag_search` → grep →
  `Read`. Don't repeat the identical call.
- Error (not indexed, DB busy) → one line, then built-in tools. Graph
  genuinely silent: DB is `.tokensave/tokensave.db`, tables `nodes`, `edges`,
  `files`. Offer an issue at https://github.com/aovestdipaperino/tokensave —
  no proprietary code in it.
