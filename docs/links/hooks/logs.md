---
paths:
  - "ai-hooks/hooklog-core.mjs"
  - "ai-hooks/state-core.mjs"
  - "ai-hooks/links-core.mjs"
  - "ai-hooks/bin/cleanup.mjs"
  - "ai-hooks/bin/clip-output.sh"
  - "ai-hooks/bin/*-impact-map.mjs"
  - "ai-hooks/claude/usage-log.mjs"
---

# hooks/logs — связи, которых граф не видит

## Флаги и переключатели
- `AI_HOOKS_LOG_DIR` (по умолчанию `~/.ai-hooks/logs`) — читают
  `ai-hooks/hooklog-core.mjs:LOG_DIR`, `ai-hooks/bin/log-error.sh`,
  `ragsave/ragsave/server.py:_log_failure`; тот же каталог зашит без переменной в
  `ai-hooks/claude/usage-log.mjs:LOG_DIR`, `ai-hooks/bin/cleanup.mjs:trimLog`,
  `ai-hooks/bin/cleanup.mjs:rollupUsage`. Сменил путь в одном месте — errors.log
  расползается на два каталога, cleanup смотрит не туда.
- `AI_HOOKS_STATE_DIR` / `~/.claude/state/clip-output` — `ai-hooks/state-core.mjs:STATE_ROOT`
  задаёт корень, `ai-hooks/bin/cleanup.mjs:TARGETS` чистит `clip-output` под ним,
  а `ai-hooks/bin/clip-output.sh` пишет в зашитый `${HOME}/.claude/state/clip-output`.
  Сдвиг корня без скрипта — полные выводы копятся и не чистятся.

## Контракты и доки
- Порог медленного хука — `ai-hooks/hooklog-core.mjs:SLOW_MS` (800) ↔ порог
  `ms > 800` в `skills/doctor/SKILL.md`. Сменил константу — doctor ставит
  диагноз «медленно» по старому порогу.
- Каталоги карты `docs/links` / `.claude/links` — три копии списка:
  `ai-hooks/links-core.mjs:MAP_DIRS`, `ai-hooks/bin/init-impact-map.mjs:OWN_DIR`
  (+ `SHARED_DIR`), `ai-hooks/bin/seed-impact-map.mjs:PATH_EXCLUDE`. Новый каталог
  в одном месте — init создаёт карту, которую links-context не подключает, или
  seed находит кандидатов в самой карте.
