#!/usr/bin/env bash
# Убирает из индекса tokensave ветки, к которым давно не возвращались, и ветки,
# которых уже нет в git. Без этого .tokensave/branches/ растёт без предела:
# каждая ветка — полная копия графа (на web_groza ~0.6–1.6 ГБ), а
# `tokensave branch gc` сам по себе сносит только ветки, удалённые из git —
# при десятках живых локальных веток этого мало (40 веток ≈ 38 ГБ).
#
# Вызывается из tokensave-branch.sh в фоне на каждый промпт, но реальную работу
# делает не чаще раза в сутки (.tokensave/.branch-prune-stamp). Порог свежести —
# TOKENSAVE_BRANCH_TTL_DAYS, по умолчанию 21. Текущая ветка и ветка по умолчанию
# не трогаются никогда. Удалённую ветку хук пере-создаст (копия предка + sync)
# при следующем checkout на неё — данные не теряются, платится разовый re-index.
set -u

repo_root="${1:?usage: tokensave-branch-prune.sh <repo_root>}"
ts_bin="/usr/local/bin/tokensave"
meta="$repo_root/.tokensave/branch-meta.json"
stamp="$repo_root/.tokensave/.branch-prune-stamp"
ttl_days="${TOKENSAVE_BRANCH_TTL_DAYS:-21}"

[ -x "$ts_bin" ] || exit 0
[ -f "$meta" ] || exit 0
command -v python3 >/dev/null 2>&1 || exit 0

# Не чаще раза в сутки: stamp есть и моложе 1440 мин — выходим.
if [ -f "$stamp" ] && [ -z "$(find "$stamp" -mmin +1440 2>/dev/null)" ]; then
  exit 0
fi

setsid bash -c '
  root="$1"; bin="$2"; meta="$3"; stamp="$4"; ttl="$5"
  log="$root/.tokensave/sync.log"

  # Тот же лок, что у tokensave-sync.sh и branch add: не пересекаемся с идущим
  # sync. Ждём его, а не пропускаем — чистка редкая, потерять её жаль.
  exec 9>"$root/.tokensave/.sync.lock"
  flock -w 900 9 || exit 0
  # Отметку ставим сразу: даже если ниже что-то упадёт, сутки не долбимся.
  touch "$stamp"

  "$bin" branch gc -p "$root" >>"$log" 2>&1 || true

  cur="$(git -C "$root" symbolic-ref --short HEAD 2>/dev/null)"
  stale="$(python3 -c "
import json, sys, time
meta, cur, ttl = sys.argv[1], sys.argv[2], int(sys.argv[3])
d = json.load(open(meta))
default = d.get(\"default_branch\")
cutoff = time.time() - ttl * 86400
for name, info in d.get(\"branches\", {}).items():
    if name == cur or name == default:
        continue
    raw = info.get(\"last_synced_at\") or info.get(\"created_at\") or 0
    try:
        last = float(raw)
    except (TypeError, ValueError):
        continue
    if last and last < cutoff:
        print(name)
" "$meta" "$cur" "$ttl" 2>/dev/null)"

  [ -z "$stale" ] && exit 0
  while IFS= read -r b; do
    [ -n "$b" ] || continue
    "$bin" branch remove "$b" -p "$root" >>"$log" 2>&1 \
      || "$HOME/.ai-hooks/bin/log-error.sh" "tokensave branch remove" "$root" "$log" "$?"
  done <<< "$stale"
' _ "$repo_root" "$ts_bin" "$meta" "$stamp" "$ttl_days" </dev/null >/dev/null 2>&1 &

exit 0
