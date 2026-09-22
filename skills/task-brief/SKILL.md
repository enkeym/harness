---
name: task-brief
description: "Turns a large, loosely worded task into a technical brief before any work starts — reads the code it touches, resolves the obvious gaps itself, argues with the prompt where the code disagrees, asks only about real forks, and writes an imperative brief (task, context, constraints, out of scope, verification, steps) that waits for approval — in Claude Code as a plan-mode file under ~/.claude/plans/, in OpenCode as a chat block; for a single decision or idea runs a short challenge instead — objections and alternatives checked against code and docs, one recommendation. Load when the prompt describes an architectural or multi-module change, a new subsystem, data model or integration, or a feature with no location, acceptance criterion or boundary named; when the user says \"подумай\", \"продумай\", \"мозговой штурм\", \"поспорь\", \"найди дыры\", \"что может пойти не так\", \"предложи как\", \"уточни если что\", \"спроси если непонятно\", or runs /task-brief."
---

# Task brief

No implementation until the brief is approved; a single decision to argue gets
the *Challenge* section instead, a plain one-line change gets neither.
`rules/core.md` gates still hold; once work starts, the stack skill carries
the rules. Argument without a check is opinion — every objection here is
verified by code, docs or a run before it reaches the user.

## Trigger

- Fires when two or more hold: more than one module or layer touched; a new
  subsystem, data model, integration or migration; no file or place named; no
  acceptance criterion; no boundary (what stays out); intent spread over
  several sentences with no structure.
- Does not fire: a bug with an error and a location; a diff the user could
  describe in one line; a prompt that already has the sections below.
- First line of the reply names why it fired, in Russian: `Задача крупная:
  <причина> — собираю бриф.` The user can wave it off. Claude Code: then
  `EnterPlanMode`; the brief is the plan file it names
  (`~/.claude/plans/<slug>.md`). OpenCode has no plan mode: brief in chat.
- "поспорь", "мозговой штурм", "найди дыры", "что может пойти не так" about one
  decision, library, schema or idea → *Challenge*, not the brief.

## Challenge

1. State the claim under test in one sentence: the user's idea, or the answer
   you would give by default.
2. Objections: the 2–4 strongest that would change the decision — a failure
   mode with its mechanism, a cost (runtime, money, migration, lock-in), a
   cheaper path, a conflict with what the code or a recorded decision already
   does. Not style, not "could be an issue" without a mechanism.
3. Check each: `tokensave_context`/`rag_search` for the code, the installed
   version's docs, `tokensave_session_recall`, a quick run when one settles
   it. Refuted → dropped silently; unverifiable → kept, marked.
4. Brainstorm asked → 3+ approaches that differ in mechanism, each with the
   one cost that decides between them. No padding options.
5. Recommend one, and name the condition that would flip it.

```markdown
Тезис: <что проверяем>

Возражения:
- <возражение> — <механизм/цена> — проверено: <файл, дока, прогон> | не проверено
Варианты: <подход — решающая цена | нет>

Рекомендация: <один выбор>. Передумаю, если: <условие>.
```

A choice made here that the user accepts → `tokensave_record_decision`.

## Reason before asking

1. Restate the goal as a result the user will see, one sentence. Can't →
   that is the first question.
2. Read what the task touches: `tokensave_context` / `rag_search` on the
   affected area, `tokensave_callers` on symbols that change,
   `tokensave_session_recall` for earlier decisions. A gap the repository
   answers is not a question.
3. List every gap and close each one of three ways: answered by code, the
   rules files or memory; defaulted to the neighbour's pattern (`Допущения`);
   or a real fork (the questions).
4. Chain the consequences: for each step ask what breaks if it is wrong —
   data, callers, auth, migration order, rollback. What breaks goes into
   `Ограничения` or `Проверка`.
5. Argue with the prompt: it contradicts the code, an existing decision, or a
   cheaper path exists → `Возражения` with the alternative. Never comply
   silently, never override silently.
6. Two approaches only when they differ in a real trade-off; recommend one.

## Questions

- A real fork = two viable options whose consequences the code cannot settle.
  Not naming, style, what the neighbour decides or the rules files answer.
- One question tool call (`AskUserQuestion` / `question`), at most three
  questions, the recommended option first and marked. A second round only if
  an answer opened a new fork.
- Zero forks → zero questions; the assumptions carry the decisions.

## The brief

Imperative, verb first, addressed to the executor; no preamble, no "я хочу",
no politeness, no restating the user's wording. Every section names files,
symbols and commands, not areas. Empty section = `нет`, never omitted.

```markdown
## Задача
<Глагол первым: что сделать, где (файл/модуль), для кого. 1–3 предложения.>

## Контекст
<Что уже есть и почему задача возникла: `src/x/y.service.ts:handleZ`,
решение из памяти, ограничение стека.>

## Ограничения
- <паттерн соседей, лимиты, что не трогать, порядок миграций>

## Вне scope
- <что не делаем, хотя лежит рядом>

## Допущения
- <что решено самостоятельно и на каком основании>

## Возражения
- <где промпт спорит с кодом или есть путь дешевле — и альтернатива>

## Проверка
- <команда или сценарий → ожидаемый результат>

## Шаги
1. <единица размером с коммит>
```

Claude Code: write the block to the plan file, then `ExitPlanMode` — it is
the approval; no chat line. OpenCode: print the block, then one line:
`Правки — по разделам; «да» — начинаю с шага 1.` Then stop.

## After the answer

- One step = one commit = one session (~20–40 turns; every later turn re-pays
  what the step dragged in). A third subsystem, a second data model or a
  migration plus its callers → two steps, each with its check.
- "да", "ок", "поехали" → step 1. A correction → rewrite the touched sections
  only, reprint just them, wait again.
- The brief is the spec: one step, one commit (`rules/core.md` commit trigger).
  A step that turns out different → one line saying so before continuing.
- Claude Code: the plan file is the brief across sessions — tick a step
  (`1. [x] …`) when its commit lands, rewrite one that changed; `handoff`
  links it from the snapshot and leaves via `ExitPlanMode`; `cleanup.mjs`
  drops a plan untouched for 14 days. OpenCode: chat only — `handoff` copies
  the remaining steps. An architectural choice → `tokensave_record_decision`.
