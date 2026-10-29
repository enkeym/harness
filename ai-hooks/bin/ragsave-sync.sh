#!/usr/bin/env bash
# Поддерживает смысловой (RAG) индекс проекта в актуальном состоянии.
# Codex SessionStart (--warm) и Stop; также явный запуск [--warm] <каталог>.
# Замок на проект (.ragsave/.sync.lock) берёт сам ragsave — один и тот же для
# хука, ручного запуска из терминала и rag_index из MCP, поэтому пересечься
# они не могут: второй пришедший выходит с кодом 3 и строкой
# «another sync is already in progress», а держатель по окончании проходит
# ещё раз; по коду 3 log-error.sh отказа не пишет.
# Только sync --quiet существующей БД (доли секунды, модель не грузится,
# если ни один файл не изменился); init — решение человека, см. ниже.
# Каталог проекта: $1 → CODEX_PROJECT_DIR → PWD.
# --warm первым аргументом — до синка `ragsave warm`:
# демон модели с обычным приоритетом и без лимита потоков, чтобы первый поиск
# сессии не ждал загрузку модели. Демон уже жив — warm ничего не делает.
set -u

warm=0
[ "${1:-}" = "--warm" ] && { warm=1; shift; }

project_dir="${1:-${CODEX_PROJECT_DIR:-$PWD}}"
[ "$project_dir" = "$HOME" ] && exit 0

repo_root="$(git -C "$project_dir" rev-parse --show-toplevel 2>/dev/null)" || exit 0
[ -z "$repo_root" ] || [ "$repo_root" = "$HOME" ] && exit 0

rag_bin="${AI_HOOKS_RAGSAVE_CMD:-$HOME/.local/bin/ragsave}"  # переменная — подмена в тестах
[ -x "$rag_bin" ] || exit 0

# Явный отказ от индексации проекта: touch .ragsave-disable в корне репозитория
# (или рядом с индексом подкаталога, см. ниже).
[ -f "$repo_root/.ragsave-disable" ] && exit 0

# Индекс — ближайший .ragsave/rag.db вверх от каталога сессии, не выше корня
# репозитория: тот же, что обслуживает MCP (mcp-serve.sh:find_root), — у подкаталога
# монорепо свой индекс. Нет ни одного — выходим. Первичный init хуком не
# запускается: решение «индексировать этот репозиторий» принимает человек,
# командой `ragsave init`. Каталог .ragsave здесь тоже не создаётся — пустой
# каталог ничего не значит, а появлялся он в любом репозитории, где просто
# открыли сессию.
root=""
dir="$(cd "$project_dir" 2>/dev/null && pwd -P)" || exit 0
while :; do
  [ -f "$dir/.ragsave/rag.db" ] && { root="$dir"; break; }
  { [ "$dir" = "$repo_root" ] || [ "$dir" = / ]; } && break
  dir="$(dirname "$dir")"
done
[ -n "$root" ] || exit 0
[ -f "$root/.ragsave-disable" ] && exit 0

log="$root/.ragsave/sync.log"

# Сироты sync.log.<pid> прерванных синков: живой синк сутки не идёт.
find "$root/.ragsave" -maxdepth 1 -name 'sync.log.*' -mmin +1440 -delete 2>/dev/null

# Каждый запуск пишет в свой файл: `>"$log"` обнулял лог идущего синка ещё до
# проверки замка. Занятый замок (код 3) — лог удаляется, ragsave сам оставил
# держателю отметку на повторный проход; иначе итог становится sync.log,
# из которого rag_status берёт last_sync.
# Фоновый синк не должен душить IDE и dev-сервер: низший приоритет CPU и IO,
# потоков ONNX — не больше 6 (без лимита onnxruntime берёт все ядра на час
# при переиндексации после смены ветки). RAGSAVE_THREADS из окружения главнее.
# Лимит и nice — только синку: демон, поднятый warm, живёт дольше синка и
# считает поиск всех сессий. setsid, ionice и их замены на macOS — background.sh.
. "${BASH_SOURCE%/*}/background.sh"
$detach bash -c '
  root="$1"; bin="$2"; log="$3"; warm="$4"; threads="$5"; low_io="$6"; tmp="$log.$$"
  if [ "$warm" = 1 ]; then
    "$bin" warm >"$tmp" 2>&1 || "$HOME/.ai-hooks/bin/log-error.sh" "ragsave warm" "$root" "$tmp" "$?"
  fi
  # low_io без кавычек: пусто — ничего, иначе команда со своими флагами.
  RAGSAVE_THREADS="$threads" nice -n 19 $low_io "$bin" sync "$root" --quiet >"$tmp" 2>&1
  code=$?
  [ "$code" = 3 ] && { rm -f "$tmp"; exit 0; }
  [ "$code" = 0 ] || "$HOME/.ai-hooks/bin/log-error.sh" "ragsave sync" "$root" "$tmp" "$code"
  mv -f "$tmp" "$log"
' _ "$root" "$rag_bin" "$log" "$warm" "${RAGSAVE_THREADS:-6}" "$low_io" </dev/null >/dev/null 2>&1 &

exit 0
