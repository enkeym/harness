## Prefer tokensave MCP tools

Before reading source files or scanning a codebase, use the tokensave MCP tools: `tokensave_context` for exploration, `tokensave_search` for a known symbol, plus `tokensave_callers`, `tokensave_callees`, `tokensave_impact`, `tokensave_node`, `tokensave_files`, and `tokensave_affected`.

### Check freshness before relying on the graph

Run `tokensave_status` to see when the index was last synced. Run `tokensave sync` or `tokensave branch add` only when the user has asked for an index update or the task already involves modifying this repository; otherwise disclose the staleness and fall back to read-only source inspection.

### Cross-project and cross-branch queries

Pass an absolute `graph_root` to query a different initialized project, adding `graph_branch` to select one of that project's tracked branches. `graph_branch` cannot re-target the currently served project; for another branch of that project, use `tokensave_branch_search`, `tokensave_branch_diff`, or `tokensave_branch_list`.

### Scoping

For non-code tasks or searching outside an indexed project, use normal filesystem and shell tools instead of tokensave MCP tools.

### SQL fallback

If the graph tools cannot answer a question, find the active database in `.tokensave/branch-meta.json` (`db_file`) (or `.tokensave/tokensave.db` if branch-meta.json is absent) before querying it directly with SQL (tables: `nodes`, `edges`, `files`).

### Tool gaps

If a tokensave tool could answer a question natively but does not, suggest the user file an issue at https://github.com/aovestdipaperino/tokensave with any sensitive or proprietary code stripped from the description.
