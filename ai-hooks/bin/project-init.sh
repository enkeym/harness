#!/usr/bin/env bash
# Достраивает недостающий индекс проекта. Ручной `tokensave init` или
# `ragsave init` — решение человека индексировать репозиторий (git-хуки
# tokensave `.tokensave/` сами не создают), поэтому второй индекс собирается
# без второй команды. Зовут обёртки tokensave/ragsave из shell/bashrc и
# shell/zshenv сразу после init и project-bootstrap на SessionStart —
# страховка для init мимо обёртки и для прогона, оборванного выключением WSL.
#
# Использование: project-init.sh [--detach] <каталог>
# --detach — проверить, есть ли что делать, напечатать одну строку в stderr и
# уйти в фон (отвязка и приоритет — background.sh); без него шаги идут здесь же.
#
# Каждый шаг сначала смотрит состояние, повтор после обрыва доделывает своё:
# - нет .tokensave/tokensave.db → `tokensave init`; `--no-git-hook`, иначе init
#   спрашивает про git-хуки и в фоне без stdin висит;
# - есть .tokensave/dirty → `tokensave sync`: прерванный init оставляет эту
#   метку, повторный init отказывается («already initialized»), а sync
#   доиндексирует всё; `tokensave verify` обрыв не отличает — на живом индексе
#   он тоже бывает ненулевым;
# - нет .ragsave/rag.db → `ragsave init`. Прерванный init оставляет частичный
#   rag.db, его добирает ragsave-sync.sh. `.ragsave-disable` — ragsave не трогаем.
# Сбой шага — запись в errors.log, следующий шаг всё равно идёт; ход —
# строками в ~/.ai-hooks/logs/project-init.log.
#
# Один прогон на проект: замок mkdir с pid внутри (flock на macOS нет).
# Мёртвый pid или замок старше суток (pid мог достаться другому процессу) —
# устаревший замок.
set -u

detach_mode=0
[ "${1:-}" = "--detach" ] && { detach_mode=1; shift; }

project_dir="${1:-$PWD}"
[ "$project_dir" = "$HOME" ] && exit 0

repo_root="$(git -C "$project_dir" rev-parse --show-toplevel 2>/dev/null)" || exit 0
[ -z "$repo_root" ] || [ "$repo_root" = "$HOME" ] && exit 0

here="${BASH_SOURCE%/*}"
# Переменные — подмена в тестах.
ts_bin="${AI_HOOKS_TOKENSAVE_CMD:-$(command -v tokensave || { [ -x "$HOME/.local/bin/tokensave" ] && echo "$HOME/.local/bin/tokensave" || echo /usr/local/bin/tokensave; })}"
rag_bin="${AI_HOOKS_RAGSAVE_CMD:-$HOME/.local/bin/ragsave}"
log_dir="${AI_HOOKS_LOG_DIR:-$HOME/.ai-hooks/logs}"
log_file="$log_dir/project-init.log"

need_ts() {
  [ -x "$ts_bin" ] && { [ ! -f "$repo_root/.tokensave/tokensave.db" ] || [ -f "$repo_root/.tokensave/dirty" ]; }
}
need_rag() {
  [ -x "$rag_bin" ] && [ ! -f "$repo_root/.ragsave-disable" ] && [ ! -f "$repo_root/.ragsave/rag.db" ]
}

# Ключ замка — как projectKey в state-core.mjs: sha256 корня, 16 символов.
key="$(printf '%s' "$repo_root" | { sha256sum 2>/dev/null || shasum -a 256; } | cut -c1-16)"
lock_dir="${AI_HOOKS_STATE_DIR:-$HOME/.claude/state}/project-init"
lock="$lock_dir/$key.lock"

# Замок держит живой прогон. Без pid — mkdir уже был, pid ещё не записан:
# живым считается минуту.
lock_busy() {
  [ -d "$lock" ] || return 1
  [ -n "$(find "$lock" -maxdepth 0 -mmin +1440 2>/dev/null)" ] && return 1
  local pid=""
  [ -f "$lock/pid" ] && read -r pid <"$lock/pid"
  [ -z "$pid" ] && { [ -z "$(find "$lock" -maxdepth 0 -mmin +1 2>/dev/null)" ]; return; }
  kill -0 "$pid" 2>/dev/null
}

need_ts || need_rag || exit 0
lock_busy && exit 0

. "$here/background.sh"

if [ "$detach_mode" = 1 ]; then
  what=""
  need_ts && what="tokensave"
  need_rag && what="${what:+$what и }ragsave"
  printf 'project-init: индекс %s строится в фоне, ход — %s\n' "$what" "$log_file" >&2
  $detach bash "${BASH_SOURCE[0]}" "$repo_root" </dev/null >/dev/null 2>&1 &
  exit 0
fi

mkdir -p "$lock_dir" "$log_dir" 2>/dev/null || exit 0
if ! mkdir "$lock" 2>/dev/null; then
  lock_busy && exit 0
  rm -rf "$lock"
  mkdir "$lock" 2>/dev/null || exit 0
fi
echo $$ >"$lock/pid"
trap 'rm -rf "$lock"' EXIT

note() {
  printf '[%s] %s | %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$repo_root" "$*" >>"$log_file" 2>/dev/null
}

# run_step <источник> <команда…>: вывод — во временный файл, при сбое его
# хвост уходит в errors.log.
run_step() {
  local src="$1" tmp="$log_dir/project-init.$$.out" code
  shift
  note "$src: start"
  # low_io без кавычек: пусто — ничего, иначе команда со своими флагами.
  nice -n 19 $low_io "$@" </dev/null >"$tmp" 2>&1
  code=$?
  note "$src: exit=$code"
  [ "$code" = 0 ] || "$here/log-error.sh" "$src" "$repo_root" "$tmp" "$code"
  rm -f "$tmp"
}

if need_ts; then
  if [ -f "$repo_root/.tokensave/tokensave.db" ]; then
    run_step "tokensave sync" "$ts_bin" sync "$repo_root"
  else
    run_step "tokensave init" "$ts_bin" init "$repo_root" --no-git-hook --cpu-usage low
  fi
fi

# Потоков ONNX не больше 6, как у фонового синка; RAGSAVE_THREADS из окружения главнее.
export RAGSAVE_THREADS="${RAGSAVE_THREADS:-6}"
need_rag && run_step "ragsave init" "$rag_bin" init "$repo_root" --quiet

exit 0
