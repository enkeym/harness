#!/usr/bin/env bash
set -u

project_dir="${1:-$PWD}"

self_dir="${BASH_SOURCE%/*}"
. "$self_dir/count-sync.sh"
t_start="$(count_now_ms)"

[ "$project_dir" = "$HOME" ] && { count_sync "$project_dir" skip-no-index; exit 0; }

. "$self_dir/index-root.sh"

repo_root="$(git_worktree_root "$project_dir")" || repo_root=""
[ -n "$repo_root" ] && { [ "$repo_root" = "$HOME" ] || [ -f "$repo_root/.tokensave-disable" ]; } && { count_sync "${repo_root:-$project_dir}" skip-no-index; exit 0; }

root="$(find_index_root .tokensave/tokensave.db "$project_dir")" || { count_sync "${repo_root:-$project_dir}" skip-no-index; exit 0; }
[ -f "$root/.tokensave-disable" ] && { count_sync "$root" skip-no-index; exit 0; }
bin="${AI_HOOKS_TOKENSAVE_CMD:-$(command -v tokensave || { [ -x "$HOME/.local/bin/tokensave" ] && echo "$HOME/.local/bin/tokensave" || echo /usr/local/bin/tokensave; })}"
[ -x "$bin" ] || { count_sync "$root" skip-no-index; exit 0; }

. "$self_dir/background.sh"
cleanup_sync_logs "$root/.tokensave"
count_sync "$root" started
count_sync "$root" shell-ms "$(( $(count_now_ms) - t_start ))"
$detach bash -c '
  root="$1"; bin="$2"; low_io="$3"; helper="$4"
  if [ -f "$helper" ]; then
    . "$helper"
  else
    count_now_ms() { echo $(( $(date +%s) * 1000 )); }
    count_sync() { :; }
  fi
  log="$root/.tokensave/sync.log"; tmp="$log.$$"
  trap '\''rm -f "$tmp"'\'' EXIT
  cd "$root" || exit 0
  t="$(count_now_ms)"
  nice -n 19 $low_io "$bin" sync "$root" >"$tmp" 2>&1
  code=$?
  count_sync "$root" sync-ms "$(( $(count_now_ms) - t ))"
  if grep -q "another sync is already in progress" "$tmp"; then
    count_sync "$root" lock-busy
    rm -f "$tmp"
    exit 0
  fi
  if [ "$code" = 0 ]; then
    esc="$(printf '\''\033'\'')"
    counts="$(sed -e "s/${esc}\[[0-9;]*m//g" "$tmp" | tr -s " " | sed -n "s/.*sync done[^0-9]*\([0-9][0-9]*\) added, \([0-9][0-9]*\) modified, \([0-9][0-9]*\) removed.*/\1 \2 \3/p" | head -1)"
    if [ -n "$counts" ]; then
      set -- $counts
      if [ "$(( $1 + $2 + $3 ))" -gt 0 ]; then count_sync "$root" changed; else count_sync "$root" no-change; fi
    fi
  else
    count_sync "$root" failure
    "$HOME/.ai-hooks/bin/log-error.sh" "tokensave sync" "$root" "$tmp" "$code"
  fi
  mv -f "$tmp" "$log"
' _ "$root" "$bin" "$low_io" "$self_dir/count-sync.sh" </dev/null >/dev/null 2>&1 &
exit 0
