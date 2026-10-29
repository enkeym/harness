# Harness development

This branch contains only the Codex integration.
Global Codex hooks are empty; ai-hooks/ contains MCP and manual indexing/map tools.
Installation: install.sh → bin/codex-install.mjs; MCP registry: mcp/servers.json.
Keep instructions concise and load skill details only when relevant.
Run node --test --test-concurrency=1 ai-hooks/test/test-*.mjs after runtime changes.
Keep user changes in vscode/ intact.
