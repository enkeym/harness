count_now_ms() {
  if [ -n "${EPOCHREALTIME:-}" ]; then
    local s="${EPOCHREALTIME%.*}" us="${EPOCHREALTIME#*.}"
    echo $(( 10#$s * 1000 + 10#${us:0:3} ))
  else
    echo $(( $(date +%s) * 1000 ))
  fi
}

count_sync() {
  local key="$1" event="$2" ms="${3:-}"
  local dir="${AI_HOOKS_COUNTER_DIR:-${AI_HOOKS_LOG_DIR:-$HOME/.ai-hooks/logs}/sync-counters}"
  local slug="${key//[^A-Za-z0-9]/-}"
  slug="${slug#-}"
  [ -n "$slug" ] || return 0
  mkdir -p "$dir" 2>/dev/null || return 0
  if [ -n "$ms" ]; then
    printf '%s %s %s\n' "$(date +%s)" "$event" "$ms" >>"$dir/$slug.log" 2>/dev/null || return 0
  else
    printf '%s %s\n' "$(date +%s)" "$event" >>"$dir/$slug.log" 2>/dev/null || return 0
  fi
}
