#!/usr/bin/env bash
set -euo pipefail
case "$(uname -s)" in MINGW*|MSYS*|CYGWIN*) echo "Используйте WSL." >&2; exit 2 ;; esac
HARNESS="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [ "${1:-}" = "--opencode" ]; then
  shift
  if [ ! -d "$HARNESS/opencode/node_modules/jsonc-parser" ]; then
    for arg in "$@"; do
      if [ "$arg" = "--check" ]; then
        echo 'Установите зависимости: npm --prefix opencode ci --ignore-scripts' >&2
        exit 1
      fi
    done
    npm --prefix "$HARNESS/opencode" ci --ignore-scripts
  fi
  exec node "$HARNESS/bin/opencode-install.mjs" "$@"
fi
[ "${1:-}" != "--codex" ] || shift
exec node "$HARNESS/bin/codex-install.mjs" "$@"
