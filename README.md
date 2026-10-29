# Codex harness

Инструкции, skills и MCP для Codex. Исходный вариант сохранён в отдельной ветке.

```bash
./install.sh
./install.sh --check
./install.sh --venv
```

Нужны Codex CLI, tokensave и Node 22.13+, 23.4+ или 24+. Linux, WSL и macOS.
Установщик связывает AGENTS.md и hooks.json с репозиторием, ставит skills по одному
в ~/.agents/skills и регистрирует MCP из mcp/servers.json. Существующие файлы
сохраняются в .bak-<timestamp>; чужие skills и MCP остаются.
Модель, авторизация, sandbox и approval policy не заменяются.

PreToolUse останавливает распознанный TokenSave поиск в обход MCP и подсказывает
tokensave_search/files или rag_search. SessionStart прогревает модель и обновляет существующий RAG-индекс; Stop запускает
фоновый синк после ответа. Новые и изменённые hooks нужно доверить через /hooks.
--check проверяет установленные файлы и MCP.
Поддерживается CODEX_HOME; config.toml обновляется через Codex CLI.

- codex/ — пользовательские инструкции и RAG hooks.
- skills/ — рабочие процедуры по областям.
- ai-hooks/ — запуск MCP, карта связей и ручные задачи индексации.
- ragsave/ — смысловой поиск; окружение собирается через --venv.
- mcp/servers.json — единый список серверов.
- vscode/ и git/ — сохранённые пользовательские настройки; автоматически не ставятся.

```bash
node --test --test-concurrency=1 ai-hooks/test/test-*.mjs
node bin/mcp-sync.mjs --check
```

Подробности: [Codex](docs/codex.md).
Перенесённые практики экономии: [контекст и токены](docs/token-efficiency.md).

Чтение кода: scoped search → tokensave_read с mode="lines" вокруг нужного
попадания. Правки — apply_patch; разрешения и sandbox — нативные Codex.
