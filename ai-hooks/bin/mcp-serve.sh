#!/usr/bin/env bash
# Запуск MCP-серверов tokensave / ragsave с явно выбранным проектом.
#
# Серверы наследуют cwd процесса клиента. Запущенный вне проекта, ragsave честно
# отвечает ошибкой «не удалось определить корень», а tokensave об этом молчит:
# он сканирует соседние инициализированные проекты и берёт ПЕРВЫЙ ПО АЛФАВИТУ.
# Так сессия, стартовавшая в $HOME, получала граф ~/main/dual-vpn при работе в
# ~/main/web_groza: гард-хук судил по БД реальной ветки, MCP отвечал из чужого
# графа, каждый Read упирался в отказ без рабочей альтернативы, и предохранитель
# выдавал «запрет снят» на каждое чтение подряд.
#
# Поэтому проект выбирается здесь и явно — по каталогу сессии, и только если
# индекс уже создан. Индекса нет — сервер не поднимается: отсутствующий
# инструмент виден сразу, чужой граф не виден никогда.
set -u

kind="${1:?usage: mcp-serve.sh tokensave|ragsave}"
start="$PWD"

. "${BASH_SOURCE%/*}/index-root.sh"

case "$kind" in
  tokensave)
    root="$(find_index_root .tokensave/tokensave.db "$start")" || {
      echo "tokensave: индекса нет ни в $start, ни выше — сервер не запущен." >&2
      echo "Индексация только ручная: tokensave init <path>." >&2
      exit 1
    }
    cd "$root" || exit 1
    # Бинарь — из PATH (Homebrew, ~/.cargo/bin); ~/.local/bin (сюда его кладёт
    # install.sh) и /usr/local/bin — на случай урезанного PATH у процесса клиента.
    # Переменная — подмена в тестах.
    bin="${AI_HOOKS_TOKENSAVE_CMD:-$(command -v tokensave || { [ -x "$HOME/.local/bin/tokensave" ] && echo "$HOME/.local/bin/tokensave" || echo /usr/local/bin/tokensave; })}"
    exec "$bin" serve -p "$root"
    ;;
  ragsave)
    root="$(find_index_root .ragsave/rag.db "$start")" || {
      echo "ragsave: индекса нет ни в $start, ни выше — сервер не запущен." >&2
      echo "Индексация только ручная: ragsave init <path>." >&2
      exit 1
    }
    cd "$root" || exit 1
    exec "${AI_HOOKS_RAGSAVE_CMD:-$HOME/.local/bin/ragsave}" serve
    ;;
  *)
    echo "неизвестный сервер: $kind (ожидалось tokensave или ragsave)" >&2
    exit 2
    ;;
esac
