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
  `ai-hooks/hooklog-core.mjs:LOG_DIR` (его импортируют `ai-hooks/claude/usage-log.mjs`
  и `ai-hooks/bin/cleanup.mjs`), `ai-hooks/bin/log-error.sh`,
  `ragsave/ragsave/server.py:_log_failure`. Сменил путь в одном месте — errors.log
  расползается на два каталога.
- `AI_HOOKS_STATE_DIR` / `~/.claude/state/clip-output` — `ai-hooks/state-core.mjs:STATE_ROOT`
  задаёт корень, `ai-hooks/bin/cleanup.mjs:TARGETS` чистит `clip-output` под ним,
  а `ai-hooks/bin/clip-output.sh` пишет в зашитый `${HOME}/.claude/state/clip-output`.
  Сдвиг корня без скрипта — полные выводы копятся и не чистятся.
- Имена журналов — `hooks.jsonl` (`ai-hooks/hooklog-core.mjs:HOOKS_LOG`), `errors.log`
  (`ai-hooks/hooklog-core.mjs:ERRORS_LOG`, `ai-hooks/bin/log-error.sh`,
  `ragsave/ragsave/server.py:_log_failure`), `usage.jsonl`
  (`ai-hooks/claude/usage-log.mjs:USAGE_FILE`, его импортирует `ai-hooks/bin/cleanup.mjs:rollupUsage`)
  ↔ зашитые имена в `ai-hooks/bin/cleanup.mjs:trimLog` и пути в `skills/doctor/SKILL.md`,
  `skills/usage/SKILL.md`, `skills/optimize/SKILL.md`. Переименовал у писателя —
  cleanup обрезает несуществующий файл, журнал растёт без предела, doctor читает пустоту.

## Контракты и доки
- Порог медленного хука — `ai-hooks/hooklog-core.mjs:SLOW_MS` (800) ↔ порог
  «`ms` > 800» у строк `slow` в таблице `skills/doctor/SKILL.md`. Сменил константу — doctor ставит
  диагноз «медленно» по старому порогу.
