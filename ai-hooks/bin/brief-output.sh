#!/usr/bin/env bash
# Явный запуск неинтерактивной команды с сохранением полного вывода.
# Аргументы исполняются напрямую; shell-строки и hooks не используются.
set -u
MAX_OUTPUT_BYTES=13000
if [ "$#" -eq 0 ]; then
  echo 'usage: bash brief-output.sh <command> [args...]' >&2
  exit 2
fi
log=$(mktemp "${TMPDIR:-/tmp}/harness-output.XXXXXX") || exit 1
view=$(mktemp "${TMPDIR:-/tmp}/harness-view.XXXXXX") || exit 1
excerpt=$(mktemp "${TMPDIR:-/tmp}/harness-excerpt.XXXXXX") || exit 1
trap 'rm -f "$view" "$excerpt"' EXIT
"$@" >"$log" 2>&1
status=$?
tr '\r' '\n' <"$log" >"$view"
display_lines=$(wc -l <"$view")
bytes=$(wc -c <"$log")
if [ "$status" -eq 0 ]; then
  tail -n 20 "$view" >"$excerpt"
elif [ "$display_lines" -le 80 ]; then
  cat "$view" >"$excerpt"
else
  head -n 20 "$view" >"$excerpt"
  printf '%s\n' '… середина сохранена в логе …' >>"$excerpt"
  tail -n 60 "$view" >>"$excerpt"
fi
summary=$(printf 'exit=%s; log_lines=%s; log_bytes=%s; full_log=%s' "$status" "$display_lines" "$bytes" "$log")
summary_bytes=$(printf '%s\n' "$summary" | wc -c)
truncate_marker='… вывод ограничен по размеру; полный лог сохранён …'
marker_bytes=$(printf '%s\n' "$truncate_marker" | wc -c)
excerpt_budget=$((MAX_OUTPUT_BYTES - summary_bytes - marker_bytes))
excerpt_bytes=$(wc -c <"$excerpt")
if [ "$excerpt_bytes" -gt "$excerpt_budget" ]; then
  head -c "$excerpt_budget" "$excerpt"
  printf '%s\n' "$truncate_marker"
else
  cat "$excerpt"
fi
printf '%s\n' "$summary"
exit "$status"
