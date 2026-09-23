#!/usr/bin/env bash
# Единая точка записи ошибок фоновых задач tokensave и ragsave.
#
# Фоновые индексации молчаливы по устройству: они уходят в setsid и их вывод
# нигде не всплывает. Если такая задача падает, узнать об этом можно было
# только заглянув в лог конкретного проекта — а знать, что смотреть, надо
# заранее. Этот файл собирает отказы обоих инструментов по всем проектам в
# одно место, чтобы разбор начинался с фактов, а не с воспроизведения.
#
# Использование: log-error.sh <источник> <корень проекта> <файл лога> <код возврата>
set -u

LOG_DIR="${AI_HOOKS_LOG_DIR:-$HOME/.ai-hooks/logs}"
LOG_FILE="$LOG_DIR/errors.log"
MAX_BYTES=$((5 * 1024 * 1024))
TAIL_LINES=25

source_name="${1:-unknown}"
project="${2:-?}"
detail_log="${3:-}"
exit_code="${4:-?}"

mkdir -p "$LOG_DIR" 2>/dev/null || exit 0

# Конкурентный sync — не отказ, а штатный пропуск: параллельная сессия или
# git-хук уже держит замок tokensave, следующий проход подхватит изменения.
# Такие записи составляли весь журнал целиком и превращали его в шум, из-за
# чего он переставал быть местом, куда стоит смотреть при реальной поломке.
if [ -n "$detail_log" ] && [ -f "$detail_log" ] &&
  grep -q 'another sync is already in progress' "$detail_log" 2>/dev/null; then
  exit 0
fi
# У ragsave код 3 означает только занятый замок (EXIT_BUSY в cli.py) — узнаём
# его по коду, не по строке в логе: ragsave-sync.sh лог такого прохода удаляет.
case "$source_name" in
ragsave*) [ "$exit_code" = 3 ] && exit 0 ;;
esac

# Ротация: один прошлый файл сохраняем, дальше не копим.
if [ -f "$LOG_FILE" ]; then
  size=$(stat -c %s "$LOG_FILE" 2>/dev/null || echo 0)
  [ "$size" -gt "$MAX_BYTES" ] && mv -f "$LOG_FILE" "$LOG_FILE.1" 2>/dev/null
fi

{
  printf '[%s] %s | %s | exit=%s\n' \
    "$(date '+%Y-%m-%d %H:%M:%S')" "$source_name" "$project" "$exit_code"
  if [ -n "$detail_log" ] && [ -f "$detail_log" ]; then
    # Спиннеры прогресса пишут ANSI-последовательности: без чистки одна запись
    # растягивалась на тысячи символов «copying DB» и прятала саму ошибку.
    # Спиннер к тому же пишет всё в одну строку, поэтому её ещё и обрезаем:
    # смысл отказа стоит в конце, но и без ограничения запись раздувалась на
    # тысячи символов «copying DB».
    tail -n "$TAIL_LINES" "$detail_log" 2>/dev/null |
      sed -e 's/\x1b\[[0-9;?]*[a-zA-Z]//g' -e 's/⠋\|⠙\|⠹\|⠸\|⠼\|⠴\|⠦\|⠧\|⠇\|⠏/\n/g' |
      grep -v '^[[:space:]]*$' | uniq | tail -n "$TAIL_LINES" |
      cut -c1-200 | sed 's/^/    /'
  fi
  printf -- '---\n'
} >>"$LOG_FILE" 2>/dev/null

exit 0
