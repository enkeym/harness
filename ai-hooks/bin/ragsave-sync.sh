#!/usr/bin/env bash
# Поддерживает смысловой (RAG) индекс проекта в актуальном состоянии.
# Вешается на SessionStart (догоняет правки между сессиями, пока идёт первый
# ход) и Stop (досборка изменений хода).
# Замок на проект (.ragsave/.sync.lock) берёт сам ragsave — один и тот же для
# хука, ручного запуска из терминала и rag_index из MCP, поэтому пересечься
# они не могут: второй пришедший выходит с кодом 3 и строкой
# «another sync is already in progress»; по коду 3 log-error.sh отказа не пишет.
# Только sync --quiet существующей БД (доли секунды, модель не грузится,
# если ни один файл не изменился); init — решение человека, см. ниже.
# Каталог проекта: $1 (OpenCode) → CLAUDE_PROJECT_DIR (Claude) → PWD.
set -u

project_dir="${1:-${CLAUDE_PROJECT_DIR:-$PWD}}"
[ "$project_dir" = "$HOME" ] && exit 0

repo_root="$(git -C "$project_dir" rev-parse --show-toplevel 2>/dev/null)" || exit 0
[ -z "$repo_root" ] || [ "$repo_root" = "$HOME" ] && exit 0

rag_bin="${AI_HOOKS_RAGSAVE_CMD:-$HOME/.local/bin/ragsave}"  # переменная — подмена в тестах
[ -x "$rag_bin" ] || exit 0

# Явный отказ от индексации проекта: touch .ragsave-disable в корне репозитория.
[ -f "$repo_root/.ragsave-disable" ] && exit 0

# Индекса нет — выходим. Первичный init хуком не запускается: решение
# «индексировать этот репозиторий» принимает человек, командой `ragsave init`.
# Каталог .ragsave здесь тоже не создаётся — пустой каталог ничего не значит,
# а появлялся он в любом репозитории, где просто открыли сессию.
[ -f "$repo_root/.ragsave/rag.db" ] || exit 0

log="$repo_root/.ragsave/sync.log"

setsid bash -c '
  root="$1"; bin="$2"; log="$3"
  "$bin" sync "$root" --quiet >"$log" 2>&1 \
    || "$HOME/.ai-hooks/bin/log-error.sh" "ragsave sync" "$root" "$log" "$?"
' _ "$repo_root" "$rag_bin" "$log" </dev/null >/dev/null 2>&1 &

exit 0
