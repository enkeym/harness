---
paths:
  - "mcp/servers.json"
  - "mcp/servers.md"
  - "bin/codex-install.mjs"
  - "bin/mcp-sync.mjs"
  - "bin/qwen-install.mjs"
  - "ai-hooks/test/test-qwen.mjs"
  - "ai-hooks/bin/mcp-serve.sh"
  - "ai-hooks/test/test-codex.mjs"
  - "ai-hooks/test/test-mcp-serve.mjs"
---

## Реестр и запуск MCP
- Qwen — `bin/qwen-install.mjs` подключает `qwen/QWEN.md`, навыки и RAG hooks;
  `bin/mcp-sync.mjs:syncQwen` переносит общий реестр в settings.json.
  `ai-hooks/bin/mcp-serve.sh` принимает `QWEN_PROJECT_DIR` раньше Codex/cwd;
  `ai-hooks/test/test-qwen.mjs` и `ai-hooks/test/test-mcp-serve.mjs` проверяют
  восстановление ссылок, сохранение настроек, timeout в мс и выбор проекта.
`mcp/servers.json` — источник списка серверов, который `bin/mcp-sync.mjs:syncCodex` приводит к конфигурации Codex через `bin/codex-install.mjs`; `ai-hooks/test/test-codex.mjs` проверяет регистрацию и сохранение пользовательских серверов. `ai-hooks/bin/mcp-serve.sh` выбирает ближайший проект с нужным индексом и запускает один сервер; `ai-hooks/test/test-mcp-serve.mjs` проверяет выбор корня, команду запуска и коды отказа. При смене транспорта или правил выбора обновлять документацию и соответствующие проверки.
