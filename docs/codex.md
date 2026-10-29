# Codex

Установка: ./install.sh; проверка: ./install.sh --check; окружение RAG: ./install.sh --venv.
--codex принимается как совместимый необязательный флаг.

AGENTS.md и hooks.json устанавливаются в CODEX_HOME (по умолчанию ~/.codex).
Skills: ~/.agents/skills. Общие скрипты: ~/.ai-hooks.
Замки ручной индексации: $CODEX_HOME/state или AI_HOOKS_STATE_DIR.
MCP обновляются из mcp/servers.json через codex mcp add/list/remove.
config.toml не заменяется; существующие сторонние MCP сохраняются.
Существующие заменяемые файлы резервируются в .bak-<timestamp>.

Глобальный hooks.json подключает PreToolUse (штатный поисковый guard TokenSave
с подсказкой tokensave/rag_search), SessionStart (прогрев модели и синк) и Stop
(синк после ответа). Скрипт быстро возвращается и отделяет фоновый процесс;
вывод индексации сохраняется в .ragsave/sync.log, а не в контексте модели.
Разрешения и sandbox использует сам Codex.
Поиск: tokensave_search/files → tokensave_read с mode="lines" и небольшим
диапазоном вокруг попадания; docs/config — rag_search. Дополнительные инструменты
открываются через tokensave_more только при необходимости, после получения схемы.
Карта docs/links читается по затронутым доменам при review/impact-проверке.
Индексы создаются явно; существующие обновляются hooks в фоне. Файл
.ragsave-disable отключает обновление проекта. Замок не допускает параллельную запись.
Проектные hooks задаются отдельно в `.codex/hooks.json` репозитория.

Для пользовательских и проектных hooks доверие проверяется в /hooks вручную.
Установщик не меняет записи доверия; --check проверяет файлы и MCP, но не исполнение hooks.
PreToolUse распознаёт Bash (в том числе exec_command), Grep, Glob и Agent.
Адаптер не исполняет запрошенную команду; для поиска наследует исключения
TokenSave (regex и файлы вне индекса), не подменяя native approvals.
При недоступности TokenSave выдаётся явное предупреждение вместо скрытой блокировки всех команд.
hooks.json и inline hooks из
config.toml выполняются вместе: исключите дублирование. features.hooks=false
или managed-only policy могут отключить локальные hooks.
Нативные контекст, resume, sandbox и разрешения остаются под управлением Codex.
Не запускайте tokensave install/reinstall/uninstall поверх harness.

Проверено на Codex CLI 0.165.0: MCP round-trip в изолированном профиле.
Документация: [Hooks](https://learn.chatgpt.com/docs/hooks).
Практики: [экономия контекста](token-efficiency.md).
