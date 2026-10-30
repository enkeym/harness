---
paths:
  - "mcp/servers.json"
  - "mcp/servers.md"
  - "bin/codex-install.mjs"
  - "bin/mcp-sync.mjs"
  - "ai-hooks/bin/mcp-serve.sh"
  - "ai-hooks/test/test-codex.mjs"
  - "ai-hooks/test/test-mcp-serve.mjs"
---

## Реестр и запуск MCP
`mcp/servers.json` — источник списка серверов, который `bin/mcp-sync.mjs:syncCodex` приводит к конфигурации Codex через `bin/codex-install.mjs`; `ai-hooks/test/test-codex.mjs` проверяет регистрацию и сохранение пользовательских серверов. `ai-hooks/bin/mcp-serve.sh` выбирает ближайший проект с нужным индексом и запускает один сервер; `ai-hooks/test/test-mcp-serve.mjs` проверяет выбор корня, команду запуска и коды отказа. При смене транспорта или правил выбора обновлять документацию и соответствующие проверки.
