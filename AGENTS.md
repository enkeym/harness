# Harness development

Shared skills, rules and MCP support the OpenCode client.
Client lifecycle hooks warm/sync existing RAG indexes. Search routing is guidance, not a blocking hook.
SessionStart/UserPromptSubmit inject shared skill routing; agents still read applicable skills.
Installation: install.sh → bin/opencode-install.mjs (--opencode is an explicit alias); MCP registry: mcp/servers.json.
Keep instructions concise and load skill details only when relevant.
Run node --test --test-concurrency=1 ai-hooks/test/test-*.mjs after runtime changes.
Keep user changes in vscode/ intact.
