# Новая машина

1. Установить Node 22.13+ или 24+, Python с sqlite extensions, Codex CLI и tokensave.
2. Войти в Codex обычным способом.
3. Клонировать репозиторий, выполнить ./install.sh и при необходимости ./install.sh --venv.
4. Проверить резервные копии прежних инструкций и hooks.
5. Перезапустить Codex. Если проект подключает собственные hooks — проверить их через /hooks.
6. Выполнить ./install.sh --check и codex mcp list.
7. Создать индексы нужных проектов командами tokensave init и ragsave init.
