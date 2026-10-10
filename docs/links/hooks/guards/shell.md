---
paths:
  - "ai-hooks/guard-core.mjs"
  - "ai-hooks/shell-core.mjs"
  - "ai-hooks/claude/read-router.mjs"
  - "ai-hooks/claude/bash-router.mjs"
  - "ai-hooks/bin/mcp-serve.sh"
  - "ai-hooks/opencode/**"
  - "ai-hooks/README.md"
---

# hooks/guards/shell — shell-гард, роутер чтения, хук tokensave, разбор shell

## Контракты и доки
- Разрешения shell — `ai-hooks/guard-core.mjs:JQ_DATA_RE`/`isScratch`/`READ_CMDS`/`copyHit` ↔ абзац
  «Allowed» раздела Bash в `rules/core.md` и «Shell guard» в
  `skills/hooks-guards/SKILL.md`. Сузил гард без правки правил — агент по
  тексту правил идёт в отказ; расширил — правила молча запрещают разрешённое.
- Обход родного grep-хука tokensave — `ai-hooks/guard-core.mjs:HOOK_OFF_RE`
  ловит имя `TOKENSAVE_DISABLE_GREP_HOOK` из подсказки самого бинаря
  (`tokensave hook-pre-tool-use`), а запрет `git grep` по рабочему дереву в `guardBash` полагается
  на то, что `grep`/`rg`/`ag` уже судит этот хук (свой `git grep` он с 7.15 судит
  тоже, но `HEAD`, текущую ветку и `$var` пропускает — наш запрет не дубль) — matcher
  `Agent|Grep|Bash|Glob` в `claude/settings.json`. Новая версия tokensave
  переименовала переменную или `tokensave install` сузил matcher — обход снова
  открыт, тесты `test-guards.mjs` этого не увидят: они бьют по нашему гарду.
  Тот же хук — причина, по которой отказ рекурсивного grep в
  `ai-hooks/security-core.mjs:guardBashSecurity` даёт `--include` только вне индекса.
- Корень индекса — вторая копия `ai-hooks/bin/mcp-serve.sh:find_root` в
  `ai-hooks/guard-core.mjs:findRoot`. По ней `guardRead` знает, на каком проекте поднят
  MCP-сервер: разошлись — роутер шлёт в tokensave без `graph_root` или туда, где его нет.
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
