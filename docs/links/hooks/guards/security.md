---
paths:
  - "ai-hooks/security-core.mjs"
  - "ai-hooks/tool-args-core.mjs"
  - "ai-hooks/claude/security-guard.mjs"
  - "ai-hooks/grant-core.mjs"
  - "ai-hooks/claude/links-context.mjs"
  - "ai-hooks/claude/tool-args.mjs"
  - "ai-hooks/claude/dispatch.mjs"
  - "ai-hooks/README.md"
  - "claude/settings.json"
---

# hooks/guards/security — гард безопасности, его пары и списки инструментов

## Контракты и доки
- Список хранилищ секретов — `ai-hooks/security-core.mjs:SECRET_FILE_RE` ↔
  `ragsave/ragsave/config.py:SECRET_NAME_RE` (+ `SECRET_IN_DIR`). Новый файл в одном
  месте — гард запрещает его чтение, а rag_search отдаёт содержимое из индекса.
- Инструменты правки — matcher `links-context` в `ai-hooks/claude/dispatch.mjs:TABLE` ↔
  `ai-hooks/claude/links-context.mjs:EDIT_TOOL_RE`. Новый инструмент правки только
  в одном месте — карта на нём молча не подключается. То же для skill-gate:
  matcher в `dispatch.mjs:TABLE` ↔ `ai-hooks/skill-core.mjs:MCP_EDIT_RE` —
  правка SKILL.md через tokensave молча проходит мимо skill-authoring. Тот же
  `MCP_EDIT_RE` берёт `ai-hooks/security-core.mjs:securityGuard` (matcher `*`):
  новый инструмент правки tokensave, не вписанный туда, правит `.env` без запрета. Источник списка — `tokensave_more` area edit
  (сейчас с `path`: `str_replace`, `multi_str_replace`, `replace_lines`, `insert_at`);
  тот же список целиком (и символьные, `rename` с `dry_run: false`) —
  `ai-hooks/ask-core.mjs:TOKENSAVE_WRITE_RE`/`TOKENSAVE_RENAME_RE` (matcher `*`): новая версия
  tokensave добавила инструмент — ask mode молча пропускает его правки.
- Алиасы tokensave — `ai-hooks/tool-args-core.mjs:normalizeToolInput` берут и хук `tool-args`, и
  `ai-hooks/security-core.mjs:securityGuard`, `ai-hooks/skill-core.mjs:editedFile` (хуки видят исходный
  вход): алиас мимо гардов — правка `.env` или SKILL.md под ним без проверки.
  Инструменты с алиасами — `ai-hooks/tool-args-core.mjs:TOOL_RE` ↔ matcher `tool-args` в
  `ai-hooks/claude/dispatch.mjs:TABLE`: новый инструмент только в `TOOL_RE` — гарды сверяют
  исправленный путь, а сервер получает угаданное имя и отвечает ошибкой.
- Окна выбора — `ai-hooks/claude/dispatch.mjs:CHOICE_TOOLS` (`AskUserQuestion`, `ExitPlanMode`,
  `EnterPlanMode`) ↔ имена интерактивных инструментов Claude Code и окно `ExitPlanMode`, где
  `skills/handoff/SKILL.md` даёт очистить контекст. Инструмент не в списке — `permit` отвечает
  ему `allow`, окно не показывается: вопрос уходит без ответа, handoff остаётся в той же сессии.
- Разрешения из промпта — категории `cat` у `ask(reason, cat)` и `gitPushReason` в
  `ai-hooks/security-core.mjs` ↔ ключи `WORD_STEMS`/`PHRASES`/`IMPLIES` в `ai-hooks/grant-core.mjs` ↔
  список категорий в `ai-hooks/README.md` и `skills/hooks-guards/SKILL.md`. Категория только в
  гарде — её ask не снимается никогда; только в словаре — мёртвое слово.
  `ai-hooks/grant-core.mjs:lastPrompt` ↔ формат транскрипта Claude Code (`type: user`,
  `origin.kind: human`, `isMeta`): Claude Code переименовал поле — разрешения молча
  пропадают (снова всегда ask), строк `granted` в `hooks.jsonl` нет.
- Правка чужого проекта — `ai-hooks/security-core.mjs:foreignEdit` берёт `ctx.cwd` из
  `ai-hooks/claude/security-guard.mjs:check` (`CLAUDE_PROJECT_DIR` ↔ `cwd`) и `repoRoot` из
  `ai-hooks/state-core.mjs`; снятие — `ai-hooks/grant-core.mjs:namesProject`. Адаптер без `cwd` —
  чужие правки молча проходят; `env-isolate.mjs` не стирает `CLAUDE_PROJECT_DIR` — тесты судят
  от проекта живой сессии.
- Проект со своим ядром гардов — `ai-hooks/claude/dispatch.mjs:projectVerdict` зовёт
  `ai/hooks/policy.mjs:policy(toolName, toolInput, { root, cwd })` проекта (ai-kit) и
  гасит deny и ask security-guard, которые проект выдаст сам. Проект переименовал
  `policy` (`crash` в `hooks.jsonl`) или поле `level` ответа — харнес отвечает целиком,
  и отказ с вопросом снова приходят дважды.
- Текст отказа рекурсивного grep и формы коммита — `hooks/guards/shell.md`.
