---
paths:
  - "ragsave/ragsave/**"
  - "ai-hooks/bin/ragsave-sync.sh"
  - "ai-hooks/bin/project-init.sh"
  - "shell/bashrc"
  - "shell/zshenv"
  - "ai-hooks/bin/background.sh"
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
- Лимит потоков фонового синка — `RAGSAVE_THREADS` (по умолчанию 6) в
  `ai-hooks/bin/ragsave-sync.sh` и `ragsave init` в `ai-hooks/bin/project-init.sh` ↔
  `ragsave/ragsave/config.py:EMBED_THREADS`.
  Переименовал переменную в одном месте — синк снова занимает все ядра.
  Лимит и `nice` действуют, только пока демона нет: при живом демоне
  (`ragsave/ragsave/daemon.py`) синк считает в нём, на всех ядрах.
- Состояние индексов для достройки — `.tokensave/tokensave.db`, `.tokensave/dirty`
  (метка прерванного `tokensave init`, внешний бинарь), `.ragsave/rag.db` и
  `.ragsave-disable` в `ai-hooks/bin/project-init.sh` ↔ `ai-hooks/links-core.mjs:indexesOf`
  (берут `project-bootstrap.mjs:completeIndex`, `bin/seed-impact-map.mjs`,
  `bin/init-impact-map.mjs`) и `ai-hooks/bin/ragsave-sync.sh`. tokensave сменил имя
  метки — оборванный init больше не долечивается достройкой.
- Корень индекса ragsave — ближайший `.ragsave/rag.db` вверх от каталога сессии:
  `ai-hooks/bin/mcp-serve.sh:find_root` (до `$HOME`) ↔ цикл в `ai-hooks/bin/ragsave-sync.sh`
  (до корня git). Разошлись — MCP ищет по индексу подкаталога монорепо, а синк
  его не обновляет никогда.
- Кто зовёт достройку — путь `~/.ai-hooks/bin/project-init.sh` и флаг `--detach` в
  `__project_init` (обёртки `tokensave`/`ragsave`, один и тот же код в `shell/bashrc` и
  `shell/zshenv`) и в `ai-hooks/claude/project-bootstrap.mjs:completeIndex` (та же пара
  «ровно один индекс», что `need_ts`/`need_rag` скрипта) ↔ `install.sh:projects_check`
  и `skills/doctor/reference/repair.md`, называющие один init. Переименовал скрипт или флаг —
  второй индекс молча не строится, а doctor всё равно называет одну команду.
  Фейк в тестах — `AI_HOOKS_PROJECT_INIT_CMD`, `ai-hooks/test/env-isolate.mjs` ставит его
  несуществующим: уберёшь — тесты с настоящим HOME запустят настоящий init.
- Демон поднимает только `ragsave/ragsave/embedder.py:Embedder.embed_query`
  (`start=True`), поток синка — нет ↔ `nice -n 19` в `ai-hooks/bin/ragsave-sync.sh`.
  Дал синку поднимать демон — демон и весь поиск живут под `nice 19`.
- Прогрев — `--warm` у SessionStart-регистрации `ragsave-sync.sh` в
  `claude/settings.json` ↔ `ragsave warm` (`ragsave/ragsave/daemon.py:warm`) в
  `ai-hooks/bin/ragsave-sync.sh` до `nice`, а `RAGSAVE_THREADS` — только синку.
  Перенёс warm под `nice` или под экспорт лимита — демон и поиск всех сессий
  живут под ним; снял `--warm` — первый поиск сессии снова ждёт загрузку модели.
- Список хранилищ секретов `ragsave/ragsave/config.py:SECRET_NAME_RE` — пара к
  гарду, строка в `hooks/guards/security.md`.
- Каталог логов `ragsave/ragsave/config.py:errors_log` — строка
  `AI_HOOKS_LOG_DIR` в `hooks/logs.md`.
