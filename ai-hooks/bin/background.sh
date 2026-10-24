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
command -v setsid >/dev/null 2>&1 && detach=setsid
low_io=""
if command -v ionice >/dev/null 2>&1; then
  low_io="ionice -c 3"
elif command -v taskpolicy >/dev/null 2>&1; then
  low_io="taskpolicy -b"
fi
