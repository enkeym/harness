#!/usr/bin/env bash
# Вызывается по завершении ответа агента (Claude: Stop, OpenCode: session.idle) —
# запускает tokensave sync в фоне, пока пользователь читает ответ.
# К следующему промпту граф уже свежий.
# Работает только внутри git-репозитория с уже инициализированной БД.
# Каталог проекта: $1 (OpenCode) → CLAUDE_PROJECT_DIR (Claude) → PWD.
set -u

project_dir="${1:-${CLAUDE_PROJECT_DIR:-$PWD}}"
[ "$project_dir" = "$HOME" ] && exit 0

repo_root="$(git -C "$project_dir" rev-parse --show-toplevel 2>/dev/null)" || exit 0
[ -z "$repo_root" ] || [ "$repo_root" = "$HOME" ] && exit 0

ts_bin="${AI_HOOKS_TOKENSAVE_CMD:-/usr/local/bin/tokensave}"  # переменная — подмена в тестах
[ -x "$ts_bin" ] || exit 0

# Явный отказ от индексации проекта: touch .tokensave-disable в корне репозитория.
[ -f "$repo_root/.tokensave-disable" ] && exit 0

[ -f "$repo_root/.tokensave/tokensave.db" ] || exit 0  # без БД нечего sync-ить

log="$repo_root/.tokensave/sync.log"

setsid bash -c '
  root="$1"; bin="$2"; log="$3"
  exec 9>"$root/.tokensave/.sync.lock"
  flock -n 9 || exit 0   # уже идёт sync — пропускаем
  "$bin" sync "$root" >"$log" 2>&1 \
    || "$HOME/.ai-hooks/bin/log-error.sh" "tokensave sync" "$root" "$log" "$?"
' _ "$repo_root" "$ts_bin" "$log" </dev/null >/dev/null 2>&1 &

exit 0
