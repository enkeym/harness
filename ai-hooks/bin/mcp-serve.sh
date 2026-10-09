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
#
# tokensave с 7.15 объявляет только ядро и прячет остальное за tokensave_more,
# а Claude Code и так отдаёт MCP-инструменты модели только по имени, схему —
# по ToolSearch. Урезанный список там ничего не экономит, зато вызов
# record_decision или session_recall падает «No such tool available». Поэтому
# под Claude Code — полный список; OpenCode грузит схемы целиком и остаётся на ядре.
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
    [ -n "${CLAUDECODE:-}" ] && export TOKENSAVE_TOOLS="${TOKENSAVE_TOOLS:-full}"
    exec "${AI_HOOKS_TOKENSAVE_CMD:-/usr/local/bin/tokensave}" serve -p "$root"  # переменная — подмена в тестах
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
