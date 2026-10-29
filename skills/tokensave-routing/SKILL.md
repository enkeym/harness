---
name: tokensave-routing
description: "Choose tokensave/ragsave searches and small line-range reads for code navigation; handle missing indexes or tools. Load before non-trivial indexed code exploration."
---

# Search and read only what is needed

For indexed files, MCP search/read is required; a shell read is not an
alternative just because the path is already known. Git diffs and other
revisions, command output/logs and files outside the index use local tools.
Discover the tool schema before calling it. Core names use the
`mcp__tokensave__tokensave_` prefix; RAG uses `mcp__ragsave__rag_search`.

| Question | Tool |
| --- | --- |
| Known symbol or exact code text | `search`, scoped with `path_include`; text uses `literal: true` |
| File by name | `files` |
| Source around a search hit | `read` with `file`, `mode: "lines"`, `lines: "A-B"` |
| Unfamiliar structure | `context`, scoped, `include_code: false`, small `max_nodes` |
| Callers and dependencies | `callers`, `callees`, `impact` |
| Concept, docs, config, CI | `rag_search`, small `limit`; `only_outside_tokensave: true` for non-code |
| Changes | Codex `apply_patch`; tokensave replacement tools when their schema fits |

- Start with a few search hits and read about 30–80 lines around the relevant
  one. Expand only when the needed context crosses that range. Do not scan a
  file in successive slices just to reconstruct its full contents.
- Example: `tokensave_read({file: "src/service.ts", mode: "lines", lines: "120-170"})`.
  Use `format: "text"` where supported. Reuse `if_digest` only for the same
  range still held in context. Read a whole small file when its full contract
  is needed; avoid large `full`, `map`, `signatures` or whole-symbol bodies.
- Exact-text lookup: a small `limit` and `exact_total: false` when counting
  every match is unnecessary. Increase limits only to answer a specific gap.
- Extra commands may be discoverable through `tokensave_more`; obtain their
  schema first. Do not assume `signature`, `affected`, `similar` or symbol
  editing commands are already exposed.
- Reuse `seen_node_ids` as `exclude_node_ids` for repeated context calls.
  Use `graph_root` for another initialized project.
- No index, unavailable/broken MCP, or a file explicitly reported unscanned →
  report once, then use `rg` and bounded shell reads for that scope. An empty
  query alone does not authorize shell-reading an indexed file: locate it
  with `files` and use `read`. Config paths outside the index use local tools.
  Initial indexing is the user's choice; do not run `init` automatically.
- No hits → broaden the query once, use RAG for synonyms, then `rg`; do not
  repeat the same empty call. RAG proximity is not proof of an exact match.
- Start RAG with 3–5 fragments and a path scope when known; expand only for
  missing evidence. Reuse fragments already read. A fresh index still may lag
  behind an edit: verify exact code in the working tree before changing it.
- Load extra tool areas only for a concrete operation, never `all` for a
  routine lookup. Keep a stable tool/instruction prefix where possible;
  discover schemas once and avoid reloading unchanged rules mid-task.
