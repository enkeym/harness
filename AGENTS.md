# Harness development

This branch contains only the Codex integration.
Codex hooks route searches through MCP and warm/sync existing RAG indexes.
Installation: install.sh → bin/codex-install.mjs; MCP registry: mcp/servers.json.
Keep instructions concise and load skill details only when relevant.
Run node --test --test-concurrency=1 ai-hooks/test/test-*.mjs after runtime changes.
Keep user changes in vscode/ intact.
