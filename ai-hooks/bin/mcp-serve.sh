#!/usr/bin/env bash
# Запуск MCP-серверов tokensave / ragsave с явно выбранным проектом.
#
# Серверы наследуют cwd процесса claude. Запущенный вне проекта, ragsave честно
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
start="${CLAUDE_PROJECT_DIR:-$PWD}"

# Ближайший вверх по дереву каталог с индексом. $HOME проектом не считается:
# ~/.tokensave — это глобальный конфиг CLI (global.db, pricing.json), а не граф
# кода, и приняв его за проект, сервер обслуживал бы весь домашний каталог.
find_root() {
  local marker="$1" dir
  dir="$(cd "$start" 2>/dev/null && pwd)" || return 1
  while [ -n "$dir" ] && [ "$dir" != "/" ] && [ "$dir" != "$HOME" ]; do
    [ -e "$dir/$marker" ] && { printf '%s\n' "$dir"; return 0; }
    dir="$(dirname "$dir")"
  done
  return 1
}

case "$kind" in
  tokensave)
    root="$(find_root .tokensave/tokensave.db)" || {
      echo "tokensave: индекса нет ни в $start, ни выше — сервер не запущен." >&2
      echo "Индексация только ручная: tokensave init <path>." >&2
      exit 1
    }
    cd "$root" || exit 1
    exec "${AI_HOOKS_TOKENSAVE_CMD:-${HARNESS_TOKENSAVE_BIN:-/usr/local/bin/tokensave}}" serve -p "$root"  # AI_HOOKS_* — подмена в тестах, HARNESS_* — из settings.json (harness.env)
    ;;
  ragsave)
    root="$(find_root .ragsave/rag.db)" || {
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
