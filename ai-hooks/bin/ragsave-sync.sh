#!/usr/bin/env bash
# Поддерживает смысловой (RAG) индекс проекта в актуальном состоянии.
# Вешается на UserPromptSubmit (первичная сборка) и Stop (досборка изменений).
# Замок на проект (.ragsave/.sync.lock) берёт сам ragsave — один и тот же для
# хука, ручного запуска из терминала и rag_index из MCP, поэтому пересечься
# они не могут: второй пришедший выходит с кодом 3 и строкой
# «another sync is already in progress», которую log-error.sh не считает отказом.
# Нет БД -> init с прогрессом в лог (долго, минуты); есть -> sync --quiet
# (доли секунды, модель не грузится, если ни один файл не изменился).
# Каталог проекта: $1 (OpenCode) → CLAUDE_PROJECT_DIR (Claude) → PWD.
set -u

project_dir="${1:-${CLAUDE_PROJECT_DIR:-$PWD}}"
[ "$project_dir" = "$HOME" ] && exit 0

repo_root="$(git -C "$project_dir" rev-parse --show-toplevel 2>/dev/null)" || exit 0
[ -z "$repo_root" ] || [ "$repo_root" = "$HOME" ] && exit 0

rag_bin="$HOME/.local/bin/ragsave"
[ -x "$rag_bin" ] || exit 0

# Явный отказ от индексации проекта: touch .ragsave-disable в корне репозитория.
[ -f "$repo_root/.ragsave-disable" ] && exit 0

mkdir -p "$repo_root/.ragsave" 2>/dev/null || exit 0
log="$repo_root/.ragsave/sync.log"

setsid bash -c '
  root="$1"; bin="$2"; log="$3"
  if [ -f "$root/.ragsave/rag.db" ]; then
    "$bin" sync "$root" --quiet >"$log" 2>&1 \
      || "$HOME/.ai-hooks/bin/log-error.sh" "ragsave sync" "$root" "$log" "$?"
  else
    "$bin" init "$root" >"$log" 2>&1 \
      || "$HOME/.ai-hooks/bin/log-error.sh" "ragsave init" "$root" "$log" "$?"
  fi
' _ "$repo_root" "$rag_bin" "$log" </dev/null >/dev/null 2>&1 &

exit 0
