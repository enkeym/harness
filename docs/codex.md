# Codex

Установка: ./install.sh; проверка: ./install.sh --check; окружение RAG: ./install.sh --venv.
--codex принимается как совместимый необязательный флаг.

AGENTS.md и hooks.json устанавливаются в CODEX_HOME (по умолчанию ~/.codex).
Skills: ~/.agents/skills. Общие скрипты: ~/.ai-hooks.
Замки ручной индексации: $CODEX_HOME/state или AI_HOOKS_STATE_DIR.
MCP обновляются из mcp/servers.json через codex mcp add/list/remove.
config.toml не заменяется; существующие сторонние MCP сохраняются.
Существующие заменяемые файлы резервируются в .bak-<timestamp>.

Глобальный hooks.json пуст. Разрешения и sandbox использует сам Codex.
Поиск: tokensave_search/files → tokensave_read с mode="lines" и небольшим
диапазоном вокруг попадания; docs/config — rag_search. Дополнительные инструменты
открываются через tokensave_more только при необходимости, после получения схемы.
Карта docs/links читается по затронутым доменам при review/impact-проверке.
Индексы создаются и обновляются явно; событийной синхронизации нет.
Проектные hooks задаются отдельно в `.codex/hooks.json` репозитория.

Для проектных hooks доверие проверяется в /hooks вручную. hooks.json и inline hooks из
config.toml выполняются вместе: исключите дублирование. features.hooks=false
или managed-only policy могут отключить локальные hooks.
Нативные контекст, resume, sandbox и разрешения остаются под управлением Codex.
Не запускайте tokensave install/reinstall/uninstall поверх harness.

Проверено на Codex CLI 0.165.0: MCP round-trip в изолированном профиле.
Документация: [Hooks](https://learn.chatgpt.com/docs/hooks).
