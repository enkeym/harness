# Codex

Установка: ./install.sh; проверка: ./install.sh --check; окружение RAG: ./install.sh --venv.
--codex принимается как совместимый необязательный флаг.
CLI устанавливается одним способом: `npm install -g @openai/codex` под nvm.
Не дублируйте его через pnpm, системный npm или Windows npm в WSL PATH.
Управляемый Codex app-server обновляется отдельно и не является второй установкой CLI.

AGENTS.md и hooks.json устанавливаются в CODEX_HOME (по умолчанию ~/.codex).
Skills: ~/.agents/skills. Общие скрипты: ~/.ai-hooks.
Замки ручной индексации: $CODEX_HOME/state или AI_HOOKS_STATE_DIR.
MCP обновляются из mcp/servers.json через codex mcp add/list/remove.
config.toml не заменяется; существующие сторонние MCP сохраняются.
Playwright стартует при первом браузерном вызове через ленивый proxy; версия
пакета и сохранённые схемы закреплены в реестре. TokenSave через тот же proxy
получает короткие описания инструментов; результаты поиска не обрезаются.
Подробности и обновление каталога: [MCP](../mcp/servers.md).
Существующие заменяемые файлы резервируются в .bak-<timestamp>.

Глобальный hooks.json подключает SessionStart (прогрев модели и синк) и Stop
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
Блокирующий поисковый PreToolUse не подключается. Выбор MCP задаётся инструкциями.
Правки и необходимые проверки выполняются без дополнительных вопросов;
подтверждение харнеса требуется только перед push.
hooks.json и inline hooks из
config.toml выполняются вместе: исключите дублирование. features.hooks=false
или managed-only policy могут отключить локальные hooks.
Нативные контекст, resume, sandbox и разрешения остаются под управлением Codex.
Не запускайте tokensave install/reinstall/uninstall поверх harness.

Проверено на Codex CLI 0.165.0: MCP round-trip в изолированном профиле.
Документация: [Hooks](https://learn.chatgpt.com/docs/hooks).
Практики: [управление контекстом](context-automation.md).
