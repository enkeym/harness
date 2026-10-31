---
paths:
  - "mcp/servers.json"
  - "mcp/servers.md"
  - "bin/codex-install.mjs"
  - "bin/mcp-sync.mjs"
  - "bin/qwen-install.mjs"
  - "ai-hooks/test/test-qwen.mjs"
  - "ai-hooks/bin/mcp-serve.sh"
  - "ai-hooks/bin/mcp-proxy.mjs"
  - "ai-hooks/bin/context-state.mjs"
  - "ai-hooks/bin/context-runner.mjs"
  - "ai-hooks/test/test-context-*.mjs"
  - "bin/mcp-catalog.mjs"
  - "mcp/playwright-tools.json"
  - "ai-hooks/test/test-codex.mjs"
  - "ai-hooks/test/test-mcp-serve.mjs"
  - "ai-hooks/test/test-mcp-proxy.mjs"
---

## Реестр и запуск MCP
- Qwen — `bin/qwen-install.mjs` подключает `qwen/QWEN.md`, навыки и RAG hooks;
  `bin/mcp-sync.mjs:syncQwen` переносит общий реестр в settings.json.
  `ai-hooks/bin/mcp-serve.sh` принимает `QWEN_PROJECT_DIR` раньше Codex/cwd;
  `ai-hooks/test/test-qwen.mjs` и `ai-hooks/test/test-mcp-serve.mjs` проверяют
  восстановление ссылок, сохранение настроек, timeout в мс и выбор проекта.
`mcp/servers.json` — источник списка серверов, который `bin/mcp-sync.mjs:syncCodex` приводит к конфигурации Codex через `bin/codex-install.mjs`; `ai-hooks/test/test-codex.mjs` проверяет регистрацию и сохранение пользовательских серверов. `ai-hooks/bin/mcp-serve.sh` выбирает ближайший проект с нужным индексом и запускает один сервер; `ai-hooks/test/test-mcp-serve.mjs` проверяет выбор корня, команду запуска и коды отказа. При смене транспорта или правил выбора обновлять документацию и соответствующие проверки.

`mcp-proxy.mjs` сокращает только описания TokenSave и откладывает запуск Playwright
до первого вызова. Версия и аргументы Playwright связаны с `playwright-tools.json`;
после их изменения обновить каталог через `bin/mcp-catalog.mjs playwright` и
проверить `--check`. `test-mcp-proxy.mjs` проверяет отсутствие раннего запуска,
один backend при параллельных вызовах и сохранение схем, уведомлений и ответов.

- `HARNESS_CONTEXT_GENERATION_FILE` и `HARNESS_CONTEXT_OUTPUT_BUDGET_FILE` — пишет
  `ai-hooks/bin/context-runner.mjs:runObjective`, читает
  `ai-hooks/bin/mcp-proxy.mjs:prepareCall` и `ai-hooks/bin/mcp-proxy.mjs:transform`.
  Без смены generation после compaction proxy может подавить уже утраченный текст;
  без сброса output ledger после хода следующий ход потеряет текстовый бюджет.
