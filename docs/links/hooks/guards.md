---
paths:
  - "ai-hooks/*-core.mjs"
  - "ai-hooks/claude/**"
  - "ai-hooks/opencode/**"
  - "ai-hooks/bin/ask-mode.mjs"
  - "ai-hooks/bin/mcp-serve.sh"
  - "ai-hooks/README.md"
---

# hooks/guards — связи, которых граф не видит

## Флаги и переключатели
- Ключ ask mode — `session_id` из входного JSON в `ai-hooks/claude/ask-guard.mjs`,
  `ask-reminder.mjs`, `statusline.mjs` ↔ `CLAUDE_CODE_SESSION_ID` в
  `ai-hooks/bin/ask-mode.mjs` (его вызывают `/ask`, `/ask-off`). Claude Code
  переименовал переменную — `/ask` пишет режим под ключ каталога, гард читает
  ключ сессии, и режим молча не включается. `ai-hooks/test/env-isolate.mjs`
  удаляет эту переменную у тестов.

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
- Разрешения shell — `ai-hooks/guard-core.mjs:JQ_DATA_RE`/`isScratch`/`READ_CMDS`/`copyHit` ↔ абзац
  «Allowed» раздела Bash в `rules/core.md` и «Shell guard» в
  `skills/hooks-guards/SKILL.md`. Сузил гард без правки правил — агент по
  тексту правил идёт в отказ; расширил — правила молча запрещают разрешённое.
- Инструменты правки — matcher `links-context` в `claude/settings.json` ↔
  `ai-hooks/claude/links-context.mjs:EDIT_TOOL_RE`. Новый инструмент правки только
  в одном месте — карта на нём молча не подключается. То же для skill-gate:
  matcher в `claude/settings.json` ↔ `ai-hooks/skill-core.mjs:MCP_EDIT_RE` —
  правка SKILL.md через tokensave молча проходит мимо skill-authoring. Тот же
  `MCP_EDIT_RE` берёт `ai-hooks/security-core.mjs:securityGuard` (matcher `*`):
  новый инструмент правки tokensave, не вписанный туда, правит харнес из чужой
  сессии без ask и `.env` без запрета. Источник списка — `tokensave_more` area edit
  (сейчас с `path`: `str_replace`, `multi_str_replace`, `replace_lines`, `insert_at`);
  тот же список целиком (и символьные, `rename` с `dry_run: false`) —
  `ai-hooks/ask-core.mjs:TOKENSAVE_WRITE_RE`/`TOKENSAVE_RENAME_RE` (matcher `*`): новая версия
  tokensave добавила инструмент — ask mode молча пропускает его правки.
- `AI_HOOKS_SKILL_GATE_OFF` — `ai-hooks/skill-core.mjs:gateEnabled` ↔
  `ai-hooks/README.md`. Переименовал — README учит несуществующему флагу.
- Обход родного grep-хука tokensave — `ai-hooks/guard-core.mjs:HOOK_OFF_RE`
  ловит имя `TOKENSAVE_DISABLE_GREP_HOOK` из подсказки самого бинаря
  (`tokensave hook-pre-tool-use`), а запрет `git grep` по рабочему дереву в `guardBash` полагается
  на то, что `grep`/`rg`/`ag` уже судит этот хук (свой `git grep` он с 7.15 судит
  тоже, но `HEAD`, текущую ветку и `$var` пропускает — наш запрет не дубль) — matcher
  `Agent|Grep|Bash|Glob` в `claude/settings.json`. Новая версия tokensave
  переименовала переменную или `tokensave install` сузил matcher — обход снова
  открыт, тесты `test-guards.mjs` этого не увидят: они бьют по нашему гарду.
- Заглушка `tokensave_read` (`unchanged: true`, поля `file`/`mode`/`mtime_ns`, блоки
  `[{type:'text'}]`; JSON или заголовок `ключ: значение` в `format: text`, который
  tokensave отдаёт по умолчанию) — `ai-hooks/read-core.mjs:parseStub`/`withBody`/`refillResponse` ↔ формат
  ответа tokensave, тест `ai-hooks/test/test-read-refill.mjs`. Сменился формат при
  обновлении tokensave — хук молча перестаёт подменять, агент снова видит пустые
  чтения. Корень индекса — вторая копия `ai-hooks/bin/mcp-serve.sh:find_root` в
  `ai-hooks/read-core.mjs:indexRoot` и `ai-hooks/guard-core.mjs:findRoot`.
- Таблица `files` индекса tokensave (`path` относительный от корня, через `/`) —
  `ai-hooks/guard-core.mjs:inIndex`/`relKey` ↔ схема БД tokensave. Сменилась схема —
  роутер чтения молча пропускает всё, тесты `test-guards.mjs` не заметят: они
  создают таблицу сами.
- Имена файлов хуков — регистрация по путям `$HOME/.ai-hooks/…` в
  `claude/settings.json`; `opencode/plugin/tokensave-guard.js` импортирует
  `~/.ai-hooks/opencode/tokensave-guard.mjs:TokensaveGuard` по `os.homedir()`. Переименовал или перенёс хук — он молча
  перестаёт вызываться; проверка только со следующей сессии.
- Разбор shell — один модуль `ai-hooks/shell-core.mjs:segments`/`commandIndex`/`gitSubcommandAt`/`baseCommand`
  (+ `copyOperands`/`redirectWords` для guard-core и `skill-core.mjs:bashWrites`;
  `makesCommit` — формы коммита для `skill-core.mjs:isGitCommit` и `ask` в
  `security-core.mjs:guardBashSecurity`: новая форма в одном месте — коммит без ревью или без подтверждения)
  на security-core, ask-core, skill-core и guard-core. Опция `keepHeredoc`
  включена в `ai-hooks/guard-core.mjs:guardBash`, `ai-hooks/ask-core.mjs:bashMutates` и
  `ai-hooks/skill-core.mjs:commitMessageProblem`: сняли — `node <<EOF` с путём или записью
  в теле проходит мимо, а сообщение `git commit -F - <<EOF` без пустой строки
  после заголовка не проверяется; включили в security-core — тело
  `cat > README.md <<EOF` читается как аргументы cat и даёт ложный запрет, а
  команды в теле `bash <<EOF` пропадают.
