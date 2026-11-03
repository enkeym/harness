---
name: tokensave-routing
description: "Choose tokensave/ragsave searches and small line-range reads for code navigation; handle missing indexes or tools. Load before non-trivial indexed code exploration."
---

# Search and read only what is needed

For indexed files, MCP search/read is required; a shell read is not an
alternative just because the path is already known. Git diffs and other
revisions, command output/logs and files outside the index use local tools.
Discover the tool schema before calling it through the active client's MCP
interface. Use its discovered callable name and arguments; do not assume that
server display labels and client callable names are interchangeable.
Before calling, check required fields and JSON types against that exact schema;
examples and retained plans do not override it. `tokensave_context` uses `task`,
whereas `tokensave_search` uses `query`; `path_include` and `path_exclude` are
arrays of strings, including for one path. Do not silently invent aliases.

On an argument/schema error, refresh only the affected tool's schema and make
one corrected retry. If it still fails, preserve the error and diagnose that
boundary with doctor; do not repeat the same payload, restart the plan or ask
for a new dialogue as a substitute for diagnosis.

| Question | Tool |
| --- | --- |
| Known symbol or exact code text | TokenSave `tokensave_search`, scoped with `path_include`; text uses `literal: true` |
| File by name | TokenSave `tokensave_files` when exposed; otherwise scoped search or `tokensave_read` on a known path |
| Source around a search hit | TokenSave `tokensave_read` with `file`, `mode: "lines"`, `lines: "A-B"` |
| Unfamiliar structure | TokenSave `tokensave_context`, scoped, `include_code: false`, small `max_nodes` |
| Callers and dependencies | TokenSave `tokensave_callers`, `tokensave_callees`, `tokensave_impact` |
| Concept, docs, config, CI | RAGSave `rag_search`, small `limit`; `only_outside_tokensave: true` for non-code |
| Changes | The active client's patch/edit tool; tokensave replacement tools when their schema fits |

- Start with a few search hits and read about 30–80 lines around the relevant
  one. Expand only when the needed context crosses that range. Do not scan a
  file in successive slices just to reconstruct its full contents.
- Use `format: "text"` where supported. Reuse `if_digest` only for the same
  range still held in context. Read a whole small file when its full contract
  is needed; avoid large `full`, `map`, `signatures` or whole-symbol bodies.
- For TokenSave ranges use `mode: "lines", lines: "A-B"`; unsupported
  `offset`/`limit` arguments do not bound a read. Never truncate a serialized
  tool response with `.slice()`: narrow the query before calling it and return
  complete selected content, preserving its header and real line numbers.
- Exact-text lookup: a small `limit` and `exact_total: false` when counting
  every match is unnecessary. Increase limits only to answer a specific gap.
- Extra commands may be discoverable through `tokensave_more`; obtain their
  schema first. Do not assume `signature`, `affected`, `similar` or symbol
  editing commands are already exposed.
- Reuse `seen_node_ids` as `exclude_node_ids` for repeated context calls.
- For the project already served by this MCP server, omit `graph_root` and
  `graph_branch`, even if its absolute path is known.
  Use `graph_root` only for another initialized project; `graph_branch`
  requires it. If an error says `graph_root selects the same project already
  served`, retry once without both selectors; this is an argument error,
  not a missing index or permission to fall back to shell reads.
- At the first project lookup, confirm the served `project_root` with
  `tokensave_status`; reuse that result until the server or target changes.
  If the requested path belongs to another project, select its verified,
  initialized root through `graph_root`. Do not guess the root or interpret
  empty results from the wrong project as missing code or a broken index.
- No index, unavailable/broken MCP, a file explicitly reported unscanned or
  excluded by the project's index configuration →
  state the failing call or coverage evidence and affected paths once, then
  use `rg` and bounded shell reads for that scope. An empty query alone does
  not authorize shell-reading an indexed file: try `tokensave_read` on its
  known path, or locate it through scoped search/`files` when exposed.
  Missing one optional tool does not disable the others. Config paths outside
  the index use local tools. A handoff or simple task does not waive routing;
  built-in read/grep/glob and shell scripts obey the same fallback conditions.
  Refresh existing indexes autonomously when stale or after changing coverage.
  Initial indexing is the user's choice; do not run `init` automatically.
- No hits → broaden the query once and use RAG for synonyms; do not repeat
  the same empty call. Use `rg` only under the evidenced fallback conditions
  above. RAG proximity is not proof of an exact match.
- Start RAG with 3–5 fragments and a path scope when known; expand only for
  missing evidence. Reuse fragments already read. A fresh index still may lag
  behind an edit: verify exact code in the working tree before changing it.
- Load extra tool areas only for a concrete operation, never `all` for a
  routine lookup. Keep a stable tool/instruction prefix where possible;
  discover schemas once and avoid reloading unchanged rules mid-task.
- Harness compacts tool descriptions at the MCP boundary; this does not
  replace mandatory indexed search/read. Tool results remain complete.
  Do not print whole discovery entries just to obtain one schema: select
  the requested tool once, and reuse already retrieved source ranges.
