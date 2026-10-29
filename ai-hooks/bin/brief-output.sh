#!/usr/bin/env bash
# Явный запуск неинтерактивной команды с сохранением полного вывода.
# Аргументы исполняются напрямую; shell-строки и hooks не используются.
set -u
if [ "$#" -eq 0 ]; then
  echo 'usage: bash brief-output.sh <command> [args...]' >&2
  exit 2
fi
log=$(mktemp "${TMPDIR:-/tmp}/harness-output.XXXXXX") || exit 1
"$@" >"$log" 2>&1
status=$?
lines=$(wc -l <"$log")
bytes=$(wc -c <"$log")
if [ "$status" -eq 0 ]; then
  tail -n 20 "$log"
elif [ "$lines" -le 80 ]; then
  cat "$log"
else
  head -n 20 "$log"
  echo '… середина сохранена в логе …'
  tail -n 60 "$log"
fi
printf '\nexit=%s; log_lines=%s; log_bytes=%s; full_log=%s\n' "$status" "$lines" "$bytes" "$log"
exit "$status"
