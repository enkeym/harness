# Agent harness

Общие инструкции, skills, MCP и фоновые hooks для агентских клиентов.
Поддерживаются Codex CLI и OpenCode.

```bash
./install.sh
./install.sh --check
./install.sh --venv
```

Нужны выбранный клиент, tokensave и Node 22.13+, 23.4+ или 24+. Linux, WSL и macOS.
По умолчанию устанавливается интеграция Codex; для OpenCode используется --opencode,
включая проверку --opencode --check. Подготовка окружения RAG выполняется через --venv.
Установщики подключают инструкции, skills и hooks в каталогах клиента
и регистрируют MCP из mcp/servers.json. Существующие заменяемые файлы
сохраняются в .bak-<timestamp>; чужие skills и MCP остаются.
Модель, авторизация, sandbox и approval policy не заменяются.

Поиск через MCP задаётся инструкциями, блокирующего PreToolUse нет.
SessionStart и UserPromptSubmit добавляют правила выбора и чтения skills из core.md.
SessionStart прогревает модель и обновляет существующий RAG-индекс; Stop запускает
фоновый синк после ответа. Доверие к hooks и разрешения управляются активным клиентом;
наличие конфигурации не доказывает исполнение hooks.
--check проверяет установленные файлы и MCP выбранного клиента.
Поддерживаются CODEX_HOME и OPENCODE_CONFIG_DIR; config.toml обновляется через Codex CLI,
opencode.jsonc — с сохранением пользовательских настроек.

- codex/ и opencode/ — инструкции и конфигурация интеграций клиентов.
- skills/ — рабочие процедуры по областям.
- ai-hooks/ — запуск MCP, карта связей и ручные задачи индексации.
- ragsave/ — смысловой поиск; окружение собирается через --venv.
- mcp/servers.json — единый список серверов.
- vscode/ и git/ — сохранённые пользовательские настройки; автоматически не ставятся.

```bash
node --test --test-concurrency=1 ai-hooks/test/test-*.mjs
node bin/mcp-sync.mjs --check
```

Подробности: [Codex](docs/codex.md), [OpenCode](docs/opencode.md), [результаты аудита](docs/harness-audit.md).
Практики экономии: [управление контекстом](docs/context-automation.md).

Чтение кода: scoped search → tokensave_read с mode="lines" вокруг нужного
попадания. Правки выполняются доступным инструментом редактирования;
разрешения и sandbox остаются под управлением активного клиента.
