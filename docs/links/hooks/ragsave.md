---
paths:
  - "ragsave/ragsave/**"
  - "ai-hooks/bin/ragsave-sync.sh"
  - "ai-hooks/bin/log-error.sh"
---

# hooks/ragsave — связи, которых граф не видит

## Контракты и доки
- Код занятого замка ragsave — `ragsave/ragsave/cli.py:EXIT_BUSY` (3) и отмены
  `EXIT_CANCELLED` (4, Ctrl+C наблюдателя шлёт держателю SIGTERM в
  `cli.py:_stop_holder`) ↔ проверка `exit_code` 3|4 для источника `ragsave*` в
  `ai-hooks/bin/log-error.sh`. Сменил код
  или дал его другому отказу — журнал снова полон пропусков или молчит о сбое.
- Лог синка и отказ от него — `.ragsave/sync.log` и `.ragsave-disable` в
  `ai-hooks/bin/ragsave-sync.sh` ↔ `ragsave/ragsave/config.py:SYNC_LOG_NAME`/`DISABLE_MARK`,
  по ним `ragsave/ragsave/indexer.py:sync_state` строит `autosync`/`last_sync` в
  `rag_status`. Переименовал в одном месте — статус снова показывает живой
  автосинк, которого нет.
- Список хранилищ секретов `ragsave/ragsave/config.py:SECRET_NAME_RE` — пара к
  гарду, строка в `hooks/guards.md`.
- Каталог логов `ragsave/ragsave/server.py:_log_failure` — строка
  `AI_HOOKS_LOG_DIR` в `hooks/logs.md`.
