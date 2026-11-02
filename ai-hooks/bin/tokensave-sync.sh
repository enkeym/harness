#!/usr/bin/env bash
set -u

project_dir="${1:-${CODEX_PROJECT_DIR:-$PWD}}"
[ "$project_dir" = "$HOME" ] && exit 0
repo_root="$(git -C "$project_dir" rev-parse --show-toplevel 2>/dev/null)" || exit 0
[ "$repo_root" = "$HOME" ] && exit 0
[ -f "$repo_root/.tokensave-disable" ] && exit 0

root=""
dir="$(cd "$project_dir" 2>/dev/null && pwd -P)" || exit 0
while :; do
  [ -f "$dir/.tokensave/tokensave.db" ] && { root="$dir"; break; }
  { [ "$dir" = "$repo_root" ] || [ "$dir" = / ]; } && break
  dir="$(dirname "$dir")"
done
[ -n "$root" ] || exit 0
[ -f "$root/.tokensave-disable" ] && exit 0
bin="${AI_HOOKS_TOKENSAVE_CMD:-$(command -v tokensave || { [ -x "$HOME/.local/bin/tokensave" ] && echo "$HOME/.local/bin/tokensave" || echo /usr/local/bin/tokensave; })}"
[ -x "$bin" ] || exit 0

. "${BASH_SOURCE%/*}/background.sh"
cleanup_sync_logs "$root/.tokensave"
$detach bash -c '
  root="$1"; bin="$2"; low_io="$3"
  log="$root/.tokensave/sync.log"; tmp="$log.$$"
  trap '\''rm -f "$tmp"'\'' EXIT
  cd "$root" || exit 0
  nice -n 19 $low_io "$bin" sync "$root" >"$tmp" 2>&1
  code=$?
  if grep -q "another sync is already in progress" "$tmp"; then
    rm -f "$tmp"
    exit 0
  fi
  [ "$code" = 0 ] || "$HOME/.ai-hooks/bin/log-error.sh" "tokensave sync" "$root" "$tmp" "$code"
  mv -f "$tmp" "$log"
' _ "$root" "$bin" "$low_io" </dev/null >/dev/null 2>&1 &
exit 0
