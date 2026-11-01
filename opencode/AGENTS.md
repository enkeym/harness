# OpenCode harness

Read `~/.config/harness/repo/rules/core.md` before the first task and follow it throughout the session.
Select applicable skills before each task and when its scope changes. Read missing or changed SKILL.md instructions from the installed skills directory before beginning their workflow.
Load tokensave-routing before project exploration. Discover MCP schemas through OpenCode's tool catalog search, then call the discovered tools through execute. Catalog search discovers tools; it does not search project files.
Start project exploration with tokensave_status and tokensave_files. Use tokensave_search for symbols or exact text, tokensave_read for source ranges, and rag_search for concepts, documentation and configuration. Scope queries to relevant paths.
Documentation and SKILL.md files may also be indexed. Their extension, a known path, or absence from the initial tool list does not justify built-in read/grep/glob or shell fallback. Use them only for files outside the index, logs and Git output, or after an explicit index/tool limitation. Confirm coverage with tokensave_files; an empty search result alone is not such a limitation.
Preserve project conventions and unrelated user changes. Use the installed tools.
