# Harness development

Shared skills, rules and MCP support multiple agent clients.
Client lifecycle hooks warm/sync existing RAG indexes. Search routing is guidance, not a blocking hook.
SessionStart/UserPromptSubmit inject shared skill routing; agents still read applicable skills.
Installation: install.sh → bin/codex-install.mjs by default, bin/opencode-install.mjs with --opencode; MCP registry: mcp/servers.json.
Keep instructions concise and load skill details only when relevant.
Run node --test --test-concurrency=1 ai-hooks/test/test-*.mjs after runtime changes.
Keep user changes in vscode/ intact.
