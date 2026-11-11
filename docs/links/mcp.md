---
paths:
  - "mcp/servers.json"
  - "mcp/servers.md"
  - "bin/mcp-sync.mjs"
  - "bin/playwright-env.mjs"
  - "ai-hooks/bin/mcp-serve.sh"
  - "ai-hooks/bin/mcp-proxy.mjs"
  - "ai-hooks/bin/context-state.mjs"
  - "ai-hooks/bin/mcp-policy.mjs"
  - "ai-hooks/mcp-policy.json"
  - "ai-hooks/test/test-context-*.mjs"
  - "bin/mcp-catalog.mjs"
  - "mcp/playwright-tools.json"
  - "ai-hooks/test/test-mcp-serve.mjs"
  - "ai-hooks/test/test-mcp-proxy.mjs"
---

## Реестр и запуск MCP
- OpenCode — `bin/opencode-install.mjs` подключает `opencode/AGENTS.md`, навыки и RAG hooks;
  `bin/mcp-sync.mjs:syncOpenCode` переносит общий реестр в opencode.jsonc.
  `ai-hooks/test/test-opencode.mjs` и `ai-hooks/test/test-mcp-serve.mjs` проверяют
  сохранение настроек и выбор проекта.
`mcp/servers.json` — общий источник списка серверов: `bin/mcp-sync.mjs:syncOpenCode` регистрирует его через `bin/opencode-install.mjs`; `ai-hooks/test/test-opencode.mjs` проверяет регистрацию и сохранение пользовательских настроек. `ai-hooks/bin/mcp-serve.sh` выбирает ближайший проект с нужным индексом и запускает один сервер; `ai-hooks/test/test-mcp-serve.mjs` проверяет выбор корня, команду запуска и коды отказа. При смене транспорта или правил выбора обновлять документацию и соответствующие проверки.

`mcp-proxy.mjs` сокращает описания TokenSave и запускает Playwright при первом
браузерном вызове. Без `PLAYWRIGHT_MCP_EXTENSION_TOKEN` такой вызов сразу получает
ошибку, а backend не запускается. Версия и аргументы Playwright связаны с
`playwright-tools.json`; после их изменения обновить каталог через
`bin/mcp-catalog.mjs playwright` и проверить `--check`. `test-mcp-proxy.mjs` проверяет
запуск по первому вызову, отказ без токена, один backend при параллельных вызовах
и сохранение схем, уведомлений и ответов.

- `harness_read_result` и `_meta.harnessFullResult` — пишет
  `ai-hooks/bin/context-state.mjs:boundTextResult`, читает
  `ai-hooks/bin/mcp-proxy.mjs:artifactCall`. Путь доступен через MCP, полный ответ
  обходит усечение; удаление свежего артефакта ломает восстановление результата.
- `HARNESS_MCP_POLICY_FILE` — читает `ai-hooks/bin/mcp-policy.mjs:loadMcpPolicy`;
  `ai-hooks/bin/context-state.mjs:safeRead` и `ai-hooks/bin/mcp-proxy.mjs:prepareCall`
  используют общую retry-политику.
- `PLAYWRIGHT_MCP_EXECUTABLE_PATH` — определяет `bin/playwright-env.mjs:playwrightEnv`,
  сохраняет `bin/mcp-sync.mjs:syncOpenCode`.
- `PLAYWRIGHT_MCP_EXTENSION_TOKEN` — берётся из `~/.config/harness/env`;
  `bin/mcp-sync.mjs:syncOpenCode` передаёт ссылку `{env:...}`. `mcp/playwright-tools.json` не должен закреплять путь, профиль
  или токен в аргументах.
- Ссылки на переменные окружения в env OpenCode сохраняет `bin/mcp-sync.mjs:syncOpenCode`; `ai-hooks/test/test-opencode.mjs` проверяет, что локальное значение не заменяет ссылку в opencode.jsonc.
- `project` у RAG и `graph_root` у TokenSave — `ai-hooks/bin/mcp-proxy.mjs:prepareCall`
  выбирает по ним БД для снятия защиты ошибок; отслеживание cwd вместо явно
  выбранного проекта задерживает восстановление до истечения circuit.
