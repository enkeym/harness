---
paths:
  - "ai-hooks/bin/background.sh"
  - "ai-hooks/bin/project-init.sh"
  - "ai-hooks/test/test-project-init.mjs"
  - "ai-hooks/bin/ragsave-sync.sh"
  - "ai-hooks/bin/tokensave-sync.sh"
  - "ai-hooks/test/test-tokensave-sync.mjs"
  - "ai-hooks/bin/log-error.sh"
  - "ai-hooks/test/test-ragsave-sync.mjs"
  - "codex/hooks.json"
  - "opencode/harness.js"
  - "ai-hooks/test/test-opencode.mjs"
---

## Жизненный цикл индексов
- `session.execution.succeeded`, `session.execution.failed`, `session.execution.interrupted` — `opencode/harness.js` подписывается на поток OpenCode V2 и запускает оба sync-скрипта с `context.location.directory`; при загрузке дополнительно прогревается RAG. `ai-hooks/test/test-opencode.mjs` проверяет все события в отдельном проекте. Подмена каталога на cwd общего сервера синхронизирует чужой индекс.
- `ai-hooks/bin/background.sh:cleanup_sync_logs` используется обоими sync hooks:
  удаляет старые `sync.log.*` по `AI_HOOKS_SYNC_LOG_RETENTION_MINUTES` (1440 минут
  по умолчанию), сохраняя свежие файлы и основной отчёт. Прерванный TokenSave sync
  также убирает временный лог через EXIT trap, кроме аварийного SIGKILL.
- Клиентские `SessionStart` и `Stop` вызывают `tokensave-sync.sh`: независимый фоновый sync существующего ближайшего индекса, без init, с `.tokensave-disable`, отчётом `.tokensave/sync.log` и общим журналом ошибок. Конкуренцию регулирует lock CLI; занятый lock сохраняет прошлый отчёт. Сценарии проверяет `test-tokensave-sync.mjs`.
- `ai-hooks/bin/log-error.sh` — общий приёмник ошибок обоих hooks; `test-project-init.mjs` и `test-ragsave-sync.mjs` проверяют запись ошибок и продолжение следующих шагов. При изменении фильтров или формата обновлять обе проверки.

- `project-init.sh` запускает `tokensave init` только при отсутствии базы и `tokensave sync` при `.tokensave/dirty`; после этого отдельно проверяет необходимость `ragsave init`. Ошибка одного шага записывается, второй шаг всё равно выполняется. `test-project-init.mjs` проверяет порядок, повторный запуск, маркеры отключения, блокировку и продолжение после ошибки.
- Клиентские `SessionStart` и `Stop` вызывают `ragsave-sync.sh`, на SessionStart с `--warm`: он синхронизирует только уже созданную базу, уважает `.ragsave-disable`, выбирает ближайший индекс монорепозитория, пишет ошибки и не принимает занятый индексный lock за отказ. `test-ragsave-sync.mjs` покрывает выбор корня, отсутствие первичного init, занятый lock и ошибки; при изменении поведения согласованно обновлять скрипт, `codex/hooks.json`, `opencode/harness.js` и проверки обеих интеграций.
