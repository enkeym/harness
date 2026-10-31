---
paths:
  - "mcp/servers.json"
  - "mcp/servers.md"
  - "bin/codex-install.mjs"
  - "bin/mcp-sync.mjs"
  - "bin/playwright-env.mjs"
  - "bin/qwen-install.mjs"
  - "ai-hooks/test/test-qwen.mjs"
  - "ai-hooks/bin/mcp-serve.sh"
  - "ai-hooks/bin/mcp-proxy.mjs"
  - "ai-hooks/bin/context-state.mjs"
  - "ai-hooks/bin/mcp-policy.mjs"
  - "ai-hooks/mcp-policy.json"
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

`mcp-proxy.mjs` сокращает описания TokenSave и откладывает запуск Playwright в Codex
до первого вызова. Версия и аргументы Playwright связаны с `playwright-tools.json`;
после их изменения обновить каталог через `bin/mcp-catalog.mjs playwright` и
проверить `--check`. `test-mcp-proxy.mjs` проверяет отсутствие раннего запуска,
один backend при параллельных вызовах и сохранение схем, уведомлений и ответов.

- `HARNESS_CONTEXT_GENERATION_FILE` и `HARNESS_CONTEXT_OUTPUT_BUDGET_FILE` — пишет
  `ai-hooks/bin/context-runner.mjs:runObjective`, читает
  `ai-hooks/bin/mcp-proxy.mjs:prepareCall` и `ai-hooks/bin/mcp-proxy.mjs:transform`.
  Без смены generation после compaction proxy может подавить уже утраченный текст;
  без сброса output ledger после хода следующий ход потеряет текстовый бюджет.
- `harness_read_result` и `_meta.harnessFullResult` — пишет
  `ai-hooks/bin/context-state.mjs:boundTextResult`, читает
  `ai-hooks/bin/mcp-proxy.mjs:artifactCall`. Путь доступен через MCP, полный ответ
  обходит усечение; удаление свежего артефакта ломает восстановление результата.
- `HARNESS_MCP_POLICY_FILE` — читает `ai-hooks/bin/mcp-policy.mjs:loadMcpPolicy`;
  `ai-hooks/bin/context-state.mjs:safeRead` и `ai-hooks/bin/mcp-proxy.mjs:prepareCall`
  используют общую retry-политику. Qwen убирает только catalog-аргументы в
  `bin/mcp-sync.mjs:syncQwen`, иначе базовые ограничения proxy обходятся.
- `config/batchWrite` — `bin/mcp-sync.mjs:syncCodex` использует
  `ai-hooks/bin/context-runner.mjs:AppServer` для точечного обновления команд;
  remove/add вместо этого теряет пользовательские опции сервера.
- `PLAYWRIGHT_MCP_EXECUTABLE_PATH` — определяет `bin/playwright-env.mjs:playwrightEnv`,
  сохраняют `bin/mcp-sync.mjs:syncCodex` и `bin/mcp-sync.mjs:syncQwen`;
  `mcp/playwright-tools.json` не должен закреплять путь или профиль в аргументах.
- `project` у RAG и `graph_root` у TokenSave — `ai-hooks/bin/mcp-proxy.mjs:prepareCall`
  выбирает по ним БД для снятия защиты ошибок; отслеживание cwd вместо явно
  выбранного проекта задерживает восстановление до истечения circuit.
