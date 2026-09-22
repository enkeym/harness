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
  `ai-hooks/claude/usage-log.mjs:LOG_DIR`, `ai-hooks/bin/cleanup.mjs:trimLog`,
  `ai-hooks/bin/cleanup.mjs:rollupUsage`. Сменил путь в одном месте — errors.log
  расползается на два каталога, cleanup смотрит не туда.
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
- Код занятого замка ragsave — `ragsave/ragsave/cli.py:EXIT_BUSY` (3) ↔ проверка
  `exit_code = 3` для источника `ragsave*` в `ai-hooks/bin/log-error.sh`. Сменил код
  или дал его другому отказу — журнал снова полон пропусков или молчит о сбое.
- `AI_HOOKS_SKILL_GATE_OFF` — `ai-hooks/skill-core.mjs:gateEnabled` ↔
  `ai-hooks/README.md`. Переименовал — README учит несуществующему флагу.
- Порог медленного хука — `ai-hooks/hooklog-core.mjs:SLOW_MS` (800) ↔ порог
  `ms > 800` в `skills/doctor/SKILL.md`. Сменил константу — doctor ставит
  диагноз «медленно» по старому порогу.
- Имена файлов хуков — регистрация по путям в `claude/settings.json`;
  `opencode/plugin/tokensave-guard.js` импортирует абсолютным путём
  `ai-hooks/opencode/tokensave-guard.mjs:TokensaveGuard`. Переименовал или перенёс хук — он молча
  перестаёт вызываться; проверка только со следующей сессии.
- Каталоги карты `docs/links` / `.claude/links` — три копии списка:
  `ai-hooks/links-core.mjs:MAP_DIRS`, `ai-hooks/bin/init-impact-map.mjs:OWN_DIR`
  (+ `SHARED_DIR`), `ai-hooks/bin/seed-impact-map.mjs:PATH_EXCLUDE`. Новый каталог
  в одном месте — init создаёт карту, которую links-context не подключает, или
  seed находит кандидатов в самой карте.
- Разбор shell — один модуль `ai-hooks/shell-core.mjs:segments`/`commandIndex`/`gitSubcommandAt`
  на security-core, ask-core, skill-core и guard-core. Опция `keepHeredoc`
  включена только в `ai-hooks/guard-core.mjs:guardBash`: сняли — `node <<EOF`
  с путём в теле проходит мимо; включили в security-core — тело
  `cat > README.md <<EOF` читается как аргументы cat и даёт ложный запрет, а
  команды в теле `bash <<EOF` пропадают.
