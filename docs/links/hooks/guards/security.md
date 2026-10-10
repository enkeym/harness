---
paths:
  - "ai-hooks/security-core.mjs"
  - "ai-hooks/tool-args-core.mjs"
  - "ai-hooks/claude/security-guard.mjs"
  - "ai-hooks/claude/links-context.mjs"
  - "ai-hooks/claude/tool-args.mjs"
  - "ai-hooks/opencode/**"
  - "ai-hooks/README.md"
---

# hooks/guards/security — гард безопасности, его пары и списки инструментов

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
- Алиасы tokensave — `ai-hooks/tool-args-core.mjs:normalizeToolInput` берут и хук `tool-args`, и
  `ai-hooks/security-core.mjs:securityGuard`, `ai-hooks/skill-core.mjs:editedFile` (хуки видят исходный
  вход): алиас мимо гардов — правка `.env` или SKILL.md под ним без проверки.
- Текст отказа рекурсивного grep и формы коммита для `ask` — `hooks/guards/shell.md`.
