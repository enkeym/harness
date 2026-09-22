---
paths:
  - "ai-hooks/**"
  - "ragsave/ragsave/server.py"
---

# hooks — связи, которых граф не видит

## Флаги и переключатели
- `AI_HOOKS_LOG_DIR` (по умолчанию `~/.ai-hooks/logs`) — читают
  `ai-hooks/hooklog-core.mjs:LOG_DIR`, `ai-hooks/bin/log-error.sh`,
  `ragsave/ragsave/server.py:_log_failure`; тот же каталог зашит без переменной в
  `ai-hooks/doctor-core.mjs:LOGS_DIR`, `ai-hooks/claude/usage-log.mjs:LOG_DIR`,
  `ai-hooks/bin/cleanup.mjs:trimLog`, `ai-hooks/bin/cleanup.mjs:rollupUsage`.
  Сменил путь в одном месте — errors.log расползается на два каталога, doctor и
  cleanup смотрят не туда.
- `AI_HOOKS_STATE_DIR` / `~/.claude/state/clip-output` — `ai-hooks/state-core.mjs:STATE_ROOT`
  задаёт корень, `ai-hooks/bin/cleanup.mjs:TARGETS` чистит `clip-output` под ним,
  а `ai-hooks/bin/clip-output.sh` пишет в зашитый `${HOME}/.claude/state/clip-output`.
  Сдвиг корня без скрипта — полные выводы копятся и не чистятся.

## Контракты и доки
- Список хранилищ секретов — `ai-hooks/security-core.mjs:SECRET_FILE_RE` ↔
  `ragsave/ragsave/config.py:SECRET_NAME_RE` (+ `SECRET_IN_DIR`). Новый файл в одном
  месте — гард запрещает его чтение, а rag_search отдаёт содержимое из индекса.
- Уровень `ask` гарда безопасности — `ai-hooks/security-core.mjs:guardBashSecurity`
  ↔ `permission.bash` в `opencode/opencode.json` и `opencode/agent/commit.md`:
  плагин `ai-hooks/opencode/tokensave-guard.mjs:TokensaveGuard` блокирует только
  `deny`. Новое `ask`-правило в ядре — OpenCode пропускает команду молча, пока
  такой же запрет не добавлен в `permission.bash`. Соответствие проверяет
  `ai-hooks/test/test-opencode-plugin.mjs:CORE_ASK` — пример туда же.
- `AI_HOOKS_DOCTOR_OFF` — `ai-hooks/doctor-core.mjs:doctorEnabled` ↔ выключатель в
  `ai-hooks/README.md`. Переименовал — README учит несуществующему флагу.
- `AI_HOOKS_SKILL_GATE_OFF` — `ai-hooks/skill-core.mjs:gateEnabled` ↔
  `ai-hooks/README.md`. То же.
- `TS_GUARD_SYNC_WAIT_MS` (800 мс) — `ai-hooks/guard-core.mjs:SYNC_WAIT_MS` ↔
  `ai-hooks/README.md`, порог `ms > 800` в `skills/doctor/SKILL.md`. Сменил
  дефолт — doctor ставит диагноз «медленно» по старому порогу.
- Имена файлов хуков — регистрация по путям в `claude/settings.json`;
  `opencode/plugin/tokensave-guard.js` импортирует абсолютным путём
  `ai-hooks/opencode/tokensave-guard.mjs:TokensaveGuard`. Переименовал или перенёс хук — он молча
  перестаёт вызываться; проверка только со следующей сессии.
- Каталоги карты `docs/links` / `.claude/links` — три копии списка:
  `ai-hooks/links-core.mjs:MAP_DIRS`, `ai-hooks/bin/init-impact-map.mjs:OWN_DIR`
  (+ `SHARED_DIR`), `ai-hooks/bin/seed-impact-map.mjs:PATH_EXCLUDE`. Новый каталог
  в одном месте — init создаёт карту, которую links-context не подключает, или
  seed находит кандидатов в самой карте.
- Разбор shell — `ai-hooks/shell-core.mjs:segments`/`commandIndex`/`gitSubcommandAt`
  (security-core, ask-core) ↔ своя копия в `ai-hooks/guard-core.mjs` и
  `ai-hooks/skill-core.mjs:gitSubcommand`. Форма команды, которую научили
  разбирать в одном месте (`&`, `$(…)`, `sudo -u`, `git --namespace x`), в
  остальных гардах проходит мимо, пока они не переведены на shell-core.
