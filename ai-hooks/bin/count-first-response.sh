#!/usr/bin/env bash
set -u

project_dir="${1:-$PWD}"
ms="${2:-}"
[ -n "$ms" ] || exit 0
[ "$project_dir" = "$HOME" ] && exit 0

self_dir="${BASH_SOURCE%/*}"
. "$self_dir/count-sync.sh"
. "$self_dir/index-root.sh"

root="$(find_index_root .tokensave/tokensave.db "$project_dir")" \
  || root="$(find_index_root .ragsave/rag.db "$project_dir")" \
  || root="$(git_worktree_root "$project_dir")" \
  || root="$(cd "$project_dir" 2>/dev/null && pwd -P)" \
  || exit 0
{ [ -n "$root" ] && [ "$root" != "$HOME" ]; } || exit 0
count_sync "$root" first-response-ms "$ms"
