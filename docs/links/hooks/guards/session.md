---
paths:
  - "ai-hooks/ask-core.mjs"
  - "ai-hooks/skill-core.mjs"
  - "ai-hooks/question-core.mjs"
  - "ai-hooks/context-core.mjs"
  - "ai-hooks/model-hint-core.mjs"
  - "ai-hooks/claude/model-hint.mjs"
  - "ai-hooks/claude/ask-*.mjs"
  - "ai-hooks/claude/statusline.mjs"
  - "ai-hooks/claude/question-guard.mjs"
  - "ai-hooks/claude/context-*.mjs"
  - "ai-hooks/claude/plan-guard.mjs"
  - "ai-hooks/claude/skill-*.mjs"
  - "ai-hooks/claude/paste-guard.mjs"
  - "ai-hooks/claude/project-bootstrap.mjs"
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
- Чтение diff перед коммитом — `ai-hooks/skill-core.mjs:readsDiff`, `unreadDiff` (что считается
  diff, отказ называет `skills/shared/review-pass.md`) ↔ шаг 1 `review-pass.md`, отказ в
  `skills/hooks-guards/SKILL.md`, шаг 2 `skills/commit/SKILL.md` (diff отдельным вызовом).
  Склеил чтение diff с коммитом в одну команду в скилле — гейт отказывает каждому коммиту.
- Конец хода по порогу — `ai-hooks/context-core.mjs:stopNoticeDue` (SOFT не блокирует,
  HAND — раз за сессию по отметке `stopHand`, HARD — каждый ход) ↔ дедупликация
  объявлений в `ai-hooks/context-core.mjs:contextNotice` и тексты `TEXTS` (SOFT просит
  меню о переносе только при оставшихся шагах, HAND/HARD — меню или `handoff`). Сменил,
  какой порог требует меню, в одном месте — Stop блокирует ход, которому meter
  велел продолжать, или пропускает ход, которому велел передачу.
- Новая просьба после SOFT и HAND — `ai-hooks/context-core.mjs:requestText` (граница «мелкая правка:
  одно место, уже прочитанное») и `TEXTS.idle.hand` (сбор данных под правки — шаги и
  передача без вопроса) ↔ абзацы о `HAND` в `skills/handoff/SKILL.md`. Сменил границу в
  одном месте — хук велит передать, а скилл доделать здесь, или наоборот.
- Форма снимка передачи — `ai-hooks/context-core.mjs:oversizedPlan` (`## Состояние`,
  заголовки «прежнее»/«устарело», `PLAN_LIMIT`) ↔ раздел Snapshot и шаг 4 в
  `skills/handoff/SKILL.md`. Переименовал раздел или поднял лимит снимка в скилле
  без хука — `ExitPlanMode` отказывает плану, собранному по скиллу, или
  пропускает наслоенный.
- Звено цепочки передач — `ai-hooks/handoff-core.mjs:lastExit`/`childOf` ↔ формат
  транскрипта Claude Code: отказ `ExitPlanMode` (`tool_result` с `is_error`, `slug`) в
  старом, первая запись пользователя с `planContent` и тем же `slug` в новом. Claude Code
  переименовал поле или стал писать ссылку на прежнюю сессию — `resume-hint` молча
  замолкает; `test-resume-hint.mjs` не заметит: транскрипты в нём собраны тестом.
- Лимиты — `ai-hooks/context-core.mjs:PASTE_LIMIT` (40k) и `PLAN_LIMIT` (12k) ↔ те же
  числа в `ai-hooks/README.md` (оба) и `OVERVIEW.md` (вставка). Сменил константу — доки обещают
  старый порог отказа.
- Признак снимка — `ai-hooks/handoff-core.mjs:isSnapshot` (`## Состояние` и `## Дальше`) ↔ шаблон
  снимка в `skills/handoff/SKILL.md` и `oversizedPlan` в `ai-hooks/context-core.mjs`. Переименовал
  заголовок в одном месте — `handoff-mark` не ставит метку, «продолжи» после `/clear` молчит.
- Пункты `.claude/bootstrap-ignore` (`husky`, `ci`, `dependabot`,
  `impact-map`) — `ai-hooks/claude/project-bootstrap.mjs:bootstrapContext` ↔
  список в `ai-hooks/README.md` и файлы `.claude/bootstrap-ignore` в чужих
  проектах. Переименовал пункт — отключённое напоминание снова приходит везде,
  README учит старому имени.
- «Карта один раз» — постоянная метка `init-<projectKey>` в
  `ai-hooks/claude/project-bootstrap.mjs:bootstrapContext` ↔ строка `/impact-map` в
  `claude/CLAUDE.md` (предлагать, только когда хук назвал пропуск) и
  `skills/hooks-guards/SKILL.md`. Вернёшь в CLAUDE.md условие «индекс есть, `docs/links/` нет» —
  агент снова предлагает карту в каждой сессии мимо метки.
- Подсказка `/model opus` — `ai-hooks/model-hint-core.mjs:noteCheck` (провал — событие
  `PostToolUseFailure`, правка — любой инструмент, кроме Bash, модель — `contextUsed().model`) ↔
  matcher `model-hint` в `ai-hooks/claude/dispatch.mjs:TABLE` (`EDIT_TOOLS` и Bash; на
  `PostToolUseFailure` — Bash) и регистрация `PostToolUseFailure` в `claude/settings.json`. Вписал в
  matcher не-правку — серия растёт без правок; Claude Code перестал отдавать ненулевой
  выход Bash через `PostToolUseFailure` или сменил `message.model` — подсказка молчит.
- Списки инструментов правки tokensave в `ask-core`/`skill-core` — `hooks/guards/security.md`;
  формы коммита и `keepHeredoc` — `hooks/guards/shell.md`.
