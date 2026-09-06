#!/usr/bin/env bash
# Запускает команду и печатает столько, сколько нужно для вывода о результате.
#
# Смысл не в аккуратности вывода, а в цене: всё, что команда напечатала, оседает
# в контексте навсегда и перечитывается на каждом следующем ходу. Простыня в
# 2000 строк от `npm ci` стоит не один раз, а столько раз, сколько шагов сделает
# сессия после неё.
#
# Печатаем голову и хвост: в голове ошибка компиляции и первый упавший тест, в
# хвосте сводка и код выхода. Середина уходит в файл — если она понадобится,
# по ней можно искать grep'ом, не втягивая её целиком.
#
# Код возврата — исходной команды, а не последней в конвейере. Иначе `npm test`
# с упавшими тестами вернул бы 0, и агент отчитался бы о зелёном прогоне.

set -uo pipefail

head_n=${CLIP_HEAD:-40}
tail_n=${CLIP_TAIL:-120}
store=${CLIP_DIR:-${HOME}/.claude/state/clip-output}

if [ $# -eq 0 ]; then
  echo "usage: clip-output.sh <command>" >&2
  exit 2
fi

mkdir -p "$store" 2>/dev/null || store=${TMPDIR:-/tmp}
full=$(mktemp "${store}/out-$(date +%Y%m%d-%H%M%S)-XXXXXX.log" 2>/dev/null) || full=$(mktemp)

bash -c "$1" >"$full" 2>&1
status=$?

total=$(wc -l <"$full" | tr -d ' ')

if [ "$total" -le $((head_n + tail_n)) ]; then
  cat "$full"
  rm -f "$full"
else
  head -n "$head_n" "$full"
  printf '\n… clip-output: пропущено %s строк из %s. Полный вывод: %s (ищи grep, не читай целиком) …\n\n' \
    "$((total - head_n - tail_n))" "$total" "$full"
  tail -n "$tail_n" "$full"
fi

exit $status
