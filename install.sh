#!/usr/bin/env bash
set -euo pipefail
case "$(uname -s)" in MINGW*|MSYS*|CYGWIN*) echo "Используйте WSL." >&2; exit 2 ;; esac
HARNESS="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [ "${1:-}" = "--qwen" ]; then
  shift
  exec node "$HARNESS/bin/qwen-install.mjs" "$@"
fi
[ "${1:-}" != "--codex" ] || shift
exec node "$HARNESS/bin/codex-install.mjs" "$@"
