#!/usr/bin/env bash
# Поддерживает смысловой (RAG) индекс проекта в актуальном состоянии.
# SessionStart (--warm) и Stop плагина OpenCode; также явный запуск [--warm] <каталог>.
# Замок на проект (.ragsave/.sync.lock) берёт сам ragsave — один и тот же для
# хука, ручного запуска из терминала и rag_index из MCP, поэтому пересечься
# они не могут: второй пришедший выходит с кодом 3 и строкой
# «another sync is already in progress», а держатель по окончании проходит
# ещё раз; по коду 3 log-error.sh отказа не пишет.
# Только sync --quiet существующей БД (доли секунды, модель не грузится,
# если ни один файл не изменился); init — решение человека, см. ниже.
# Каталог проекта: $1 → PWD.
# --warm первым аргументом — до синка `ragsave warm`:
# демон модели с обычным приоритетом и без лимита потоков, чтобы первый поиск
# сессии не ждал загрузку модели. Демон уже жив — warm ничего не делает.
set -u

warm=0
[ "${1:-}" = "--warm" ] && { warm=1; shift; }

project_dir="${1:-$PWD}"

self_dir="${BASH_SOURCE%/*}"
. "$self_dir/count-sync.sh"
t_start="$(count_now_ms)"

[ "$project_dir" = "$HOME" ] && { count_sync "$project_dir" skip-no-index; exit 0; }

. "$self_dir/index-root.sh"

repo_root="$(git_worktree_root "$project_dir")" || repo_root=""
# Явный отказ от индексации проекта: touch .ragsave-disable в корне репозитория
# (или рядом с индексом подкаталога, см. ниже).
[ -n "$repo_root" ] && { [ "$repo_root" = "$HOME" ] || [ -f "$repo_root/.ragsave-disable" ]; } && { count_sync "${repo_root:-$project_dir}" skip-no-index; exit 0; }

rag_bin="${AI_HOOKS_RAGSAVE_CMD:-$HOME/.local/bin/ragsave}"  # переменная — подмена в тестах
[ -x "$rag_bin" ] || { count_sync "${repo_root:-$project_dir}" skip-no-index; exit 0; }

root="$(find_index_root .ragsave/rag.db "$project_dir")" || { count_sync "${repo_root:-$project_dir}" skip-no-index; exit 0; }
[ -f "$root/.ragsave-disable" ] && { count_sync "$root" skip-no-index; exit 0; }

log="$root/.ragsave/sync.log"
. "$self_dir/background.sh"

# Сироты sync.log.<pid> прерванных синков: живой синк сутки не идёт.
cleanup_sync_logs "$root/.ragsave"

# Каждый запуск пишет в свой файл: `>"$log"` обнулял лог идущего синка ещё до
# проверки замка. Занятый замок (код 3) — лог удаляется, ragsave сам оставил
# держателю отметку на повторный проход; иначе итог становится sync.log,
# из которого rag_status берёт last_sync.
# Фоновый синк не должен душить IDE и dev-сервер: низший приоритет CPU и IO,
# потоков ONNX — не больше 6 (без лимита onnxruntime берёт все ядра на час
# при переиндексации после смены ветки). RAGSAVE_THREADS из окружения главнее.
# Лимит и nice — только синку: демон, поднятый warm, живёт дольше синка и
# считает поиск всех сессий. setsid, ionice и их замены на macOS — background.sh.
count_sync "$root" started
count_sync "$root" shell-ms "$(( $(count_now_ms) - t_start ))"
$detach bash -c '
  root="$1"; bin="$2"; log="$3"; warm="$4"; threads="$5"; low_io="$6"; helper="$7"; tmp="$log.$$"
  if [ -f "$helper" ]; then
    . "$helper"
  else
    count_now_ms() { echo $(( $(date +%s) * 1000 )); }
    count_sync() { :; }
  fi
  if [ "$warm" = 1 ]; then
    wt="$(count_now_ms)"
    "$bin" warm >"$tmp" 2>&1 || "$HOME/.ai-hooks/bin/log-error.sh" "ragsave warm" "$root" "$tmp" "$?"
    count_sync "$root" warm-ms "$(( $(count_now_ms) - wt ))"
  fi
  # low_io без кавычек: пусто — ничего, иначе команда со своими флагами.
  t="$(count_now_ms)"
  RAGSAVE_THREADS="$threads" nice -n 19 $low_io "$bin" sync "$root" --quiet >"$tmp" 2>&1
  code=$?
  count_sync "$root" sync-ms "$(( $(count_now_ms) - t ))"
  [ "$code" = 3 ] && { count_sync "$root" lock-busy; rm -f "$tmp"; exit 0; }
  if [ "$code" = 0 ]; then
    counts="$(tr -d "\n " < "$tmp" | sed -n "s/.*\"added\":\([0-9][0-9]*\),\"updated\":\([0-9][0-9]*\),\"removed\":\([0-9][0-9]*\).*/\1 \2 \3/p" | head -1)"
    if [ -n "$counts" ]; then
      set -- $counts
      if [ "$(( $1 + $2 + $3 ))" -gt 0 ]; then count_sync "$root" changed; else count_sync "$root" no-change; fi
    fi
  else
    count_sync "$root" failure
    "$HOME/.ai-hooks/bin/log-error.sh" "ragsave sync" "$root" "$tmp" "$code"
  fi
  # sync.log — единственный источник last_sync, и пустой файл rag_status читает
  # как «синк упал». Пустой успешный отчёт оставляем прошлый, неудачный — пишем.
  if [ "$code" = 0 ] && [ ! -s "$tmp" ]; then rm -f "$tmp"; else mv -f "$tmp" "$log"; fi
' _ "$root" "$rag_bin" "$log" "$warm" "${RAGSAVE_THREADS:-6}" "$low_io" "$self_dir/count-sync.sh" </dev/null >/dev/null 2>&1 &

exit 0
