---
paths:
  - "ai-hooks/bin/project-init.sh"
  - "ai-hooks/test/test-project-init.mjs"
  - "ai-hooks/bin/ragsave-sync.sh"
  - "ai-hooks/bin/log-error.sh"
  - "ai-hooks/test/test-ragsave-sync.mjs"
  - "codex/hooks.json"
---

## Жизненный цикл индексов
- `ai-hooks/bin/log-error.sh` — общий приёмник ошибок обоих hooks; `test-project-init.mjs` и `test-ragsave-sync.mjs` проверяют запись ошибок и продолжение следующих шагов. При изменении фильтров или формата обновлять обе проверки.

- `project-init.sh` запускает `tokensave init` только при отсутствии базы и `tokensave sync` при `.tokensave/dirty`; после этого отдельно проверяет необходимость `ragsave init`. Ошибка одного шага записывается, второй шаг всё равно выполняется. `test-project-init.mjs` проверяет порядок, повторный запуск, маркеры отключения, блокировку и продолжение после ошибки.
- Codex `SessionStart` и `Stop` вызывают `ragsave-sync.sh`: он синхронизирует только уже созданную базу, уважает `.ragsave-disable`, выбирает ближайший индекс монорепозитория, пишет ошибки и не принимает занятый индексный lock за отказ. `test-ragsave-sync.mjs` покрывает hooks, выбор корня, отсутствие первичного init, занятый lock и ошибки; при изменении этого поведения обновлять тест вместе со скриптом и `codex/hooks.json`.
