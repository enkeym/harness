---
paths:
  - "ai-hooks/ask-core.mjs"
  - "ai-hooks/skill-core.mjs"
  - "ai-hooks/question-core.mjs"
  - "ai-hooks/context-core.mjs"
  - "ai-hooks/claude/ask-*.mjs"
  - "ai-hooks/claude/statusline.mjs"
  - "ai-hooks/claude/question-guard.mjs"
  - "ai-hooks/claude/context-*.mjs"
  - "ai-hooks/claude/plan-guard.mjs"
  - "ai-hooks/claude/skill-*.mjs"
  - "ai-hooks/bin/ask-mode.mjs"
  - "ai-hooks/README.md"
---

# hooks/guards/session — ask mode, skill-gate, конец хода, передача

## Флаги и переключатели
- Ключ ask mode — `session_id` из входного JSON в `ai-hooks/claude/ask-guard.mjs`,
  `ask-reminder.mjs`, `statusline.mjs` ↔ `CLAUDE_CODE_SESSION_ID` в
  `ai-hooks/bin/ask-mode.mjs` (его вызывают `/ask`, `/ask-off`). Claude Code
  переименовал переменную — `/ask` пишет режим под ключ каталога, гард читает
  ключ сессии, и режим молча не включается. `ai-hooks/test/env-isolate.mjs`
  удаляет эту переменную у тестов.

## Контракты и доки
- `AI_HOOKS_SKILL_GATE_OFF` — `ai-hooks/skill-core.mjs:gateEnabled` ↔
  `ai-hooks/README.md`. Переименовал — README учит несуществующему флагу.
- Конец хода по порогу — `ai-hooks/question-core.mjs:questionVerdict` (условие
  `stage !== 'soft'` для сессии без работы) ↔ `ai-hooks/context-core.mjs:TEXTS`
  (`idle.soft` передачу не просит, остальные велят меню или `handoff`). Сменил,
  какой порог требует меню, в одном месте — Stop блокирует ход, которому meter
  велел продолжать, или пропускает ход, которому велел передачу.
- Форма снимка передачи — `ai-hooks/context-core.mjs:oversizedPlan` (`## Состояние`,
  заголовки «прежнее»/«устарело», `PLAN_LIMIT`) ↔ раздел Snapshot и шаг 4 в
  `skills/handoff/SKILL.md`. Переименовал раздел или поднял лимит снимка в скилле
  без хука — `ExitPlanMode` отказывает плану, собранному по скиллу, или
  пропускает наслоенный.
- Списки инструментов правки tokensave в `ask-core`/`skill-core` — `hooks/guards/security.md`;
  формы коммита и `keepHeredoc` — `hooks/guards/shell.md`.
