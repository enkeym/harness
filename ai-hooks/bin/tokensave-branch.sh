#!/usr/bin/env bash
# Вызывается на новом сообщении пользователя (Claude: UserPromptSubmit,
# OpenCode: chat.message) — управляет ветками tokensave.
# Первичный init если нет БД; branch add если ветка новая; branch gc.
# Всё в фоне — не блокирует начало ответа.
# Каталог проекта: $1 (OpenCode) → CLAUDE_PROJECT_DIR (Claude) → PWD.
set -u

project_dir="${1:-${CLAUDE_PROJECT_DIR:-$PWD}}"
[ "$project_dir" = "$HOME" ] && exit 0

repo_root="$(git -C "$project_dir" rev-parse --show-toplevel 2>/dev/null)" || exit 0
[ -z "$repo_root" ] || [ "$repo_root" = "$HOME" ] && exit 0

ts_bin="/usr/local/bin/tokensave"
[ -x "$ts_bin" ] || exit 0

# Явный отказ от индексации проекта: touch .tokensave-disable в корне репозитория.
[ -f "$repo_root/.tokensave-disable" ] && exit 0

mkdir -p "$repo_root/.tokensave" 2>/dev/null

log="$repo_root/.tokensave/sync.log"

# Нет БД — первичная индексация (может быть долгой).
# Лок .sync.lock общий с tokensave-sync.sh → init/sync/branch-add взаимно
# исключаются, параллельные промпты не плодят конкурирующие init и не портят БД.
if [ ! -f "$repo_root/.tokensave/tokensave.db" ]; then
  setsid bash -c '
    root="$1"; bin="$2"; log="$3"
    exec 9>"$root/.tokensave/.sync.lock"
    flock -n 9 || exit 0
    "$bin" init "$root" >"$log" 2>&1 \
      || "$HOME/.ai-hooks/bin/log-error.sh" "tokensave init" "$root" "$log" "$?"
  ' _ "$repo_root" "$ts_bin" "$log" </dev/null >/dev/null 2>&1 &
  exit 0
fi

# Detached HEAD — ветки нет, нечего добавлять
branch="$(git -C "$repo_root" symbolic-ref --short HEAD 2>/dev/null)"
[ -z "$branch" ] && exit 0

# Проверить, отслеживается ли ветка
meta="$repo_root/.tokensave/branch-meta.json"
tracked=1
if [ -f "$meta" ]; then
  if command -v python3 >/dev/null 2>&1; then
    python3 -c "
import json, sys
d = json.load(open(sys.argv[1]))
sys.exit(0 if sys.argv[2] in d.get('branches', {}) else 1)
" "$meta" "$branch" && tracked=0
  else
    grep -Fq "\"$branch\":" "$meta" && tracked=0
  fi
fi

# Ветка уже отслеживается — sync сделает tokensave-sync.sh по завершении ответа
[ "$tracked" -eq 0 ] && exit 0

# Новая ветка: добавить (копия ближайшего предка + sync) и почистить старые.
# Тот же лок, что у tokensave-sync.sh — не пересекаемся с параллельным sync.
#
# Лок ЖДЁМ, а не пропускаем: `flock -n` здесь молча терял добавление ветки,
# если в этот момент шёл sync, и дальше MCP отвечал графом родительской ветки
# («results come from branch dev, but your working tree is on feature/…»).
# Пропустить sync не страшно — он повторится на следующем Stop; пропустить
# branch add нечем.
setsid bash -c '
  bin="$1"; branch="$2"; root="$3"; log="$4"
  exec 9>"$root/.tokensave/.sync.lock"
  flock -w 900 9 || exit 0
  # пока ждали лок, ветку мог добавить параллельный хук
  grep -Fq "\"$branch\":" "$root/.tokensave/branch-meta.json" 2>/dev/null && exit 0
  "$bin" branch add "$branch" -p "$root" >"$log" 2>&1 \
    || "$HOME/.ai-hooks/bin/log-error.sh" "tokensave branch add" "$root" "$log" "$?"
  "$bin" branch gc -p "$root" >>"$log" 2>&1 \
    || "$HOME/.ai-hooks/bin/log-error.sh" "tokensave branch gc" "$root" "$log" "$?"
' _ "$ts_bin" "$branch" "$repo_root" "$log" </dev/null >/dev/null 2>&1 &

exit 0
