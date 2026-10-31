# Общая часть фоновых задач индексации (ragsave-sync.sh, project-init.sh):
# подключается через `.`, задаёт $detach и $low_io.
# Фоновая задача не должна душить IDE и dev-сервер и не должна умирать вместе с
# терминалом: `$detach` отвязывает её от сессии, `nice -n 19 $low_io` у самой
# команды понижает CPU и IO.
# На macOS нет ни setsid, ни ionice. Без setsid — обычный фон `&`: вывод уже в
# /dev/null, вызывающий его не ждёт. Без ionice — taskpolicy -b (фоновый QoS
# macOS: и CPU, и IO), нет и его — один nice.
# Обе переменные подставляются без кавычек: пусто — ничего, иначе команда со
# своими флагами.
detach=""
sync_log_retention_minutes="${AI_HOOKS_SYNC_LOG_RETENTION_MINUTES:-1440}"
cleanup_sync_logs() {
  [[ "$sync_log_retention_minutes" =~ ^[0-9]+$ ]] || return 1
  find "$1" -maxdepth 1 -name 'sync.log.*' -mmin "+$sync_log_retention_minutes" -delete 2>/dev/null
}
command -v setsid >/dev/null 2>&1 && detach=setsid
low_io=""
if command -v ionice >/dev/null 2>&1; then
  low_io="ionice -c 3"
elif command -v taskpolicy >/dev/null 2>&1; then
  low_io="taskpolicy -b"
fi
