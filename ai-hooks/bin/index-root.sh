find_index_root() {
  local marker="$1" start="${2:-$PWD}" phys boundary dir
  [ -n "$marker" ] || return 1
  phys="$(cd "$start" 2>/dev/null && pwd -P)" || return 1
  [ -n "$phys" ] || return 1
  { [ "$phys" = / ] || [ "$phys" = "$HOME" ]; } && return 1
  boundary="$(git_worktree_root "$phys")" || boundary=""
  if [ -n "$boundary" ]; then
    { [ "$boundary" = / ] || [ "$boundary" = "$HOME" ]; } && return 1
    dir="$phys"
    while :; do
      [ -f "$dir/$marker" ] && { printf '%s\n' "$dir"; return 0; }
      [ "$dir" = "$boundary" ] && break
      dir="$(dirname "$dir")"
    done
    return 1
  fi
  dir="$phys"
  while [ "$dir" != / ] && [ "$dir" != "$HOME" ]; do
    [ -f "$dir/$marker" ] && { printf '%s\n' "$dir"; return 0; }
    dir="$(dirname "$dir")"
  done
  return 1
}

git_worktree_root() {
  local start="${1:-$PWD}" phys
  phys="$(cd "$start" 2>/dev/null && pwd -P)" || return 1
  git -C "$phys" rev-parse --show-toplevel 2>/dev/null
}
