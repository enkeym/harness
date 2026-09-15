---
name: task-brief
description: Turns a large, loosely worded task into a technical brief before any work starts — reads the code it touches, resolves the obvious gaps itself, argues with the prompt where the code disagrees, asks only about real forks, and prints an imperative brief (task, context, constraints, out of scope, verification, steps) that waits for approval. Load when the prompt describes an architectural or multi-module change, a new subsystem, data model or integration, or a feature with no location, acceptance criterion or boundary named; when the user says "подумай", "продумай", "мозговой штурм", "поспорь", "предложи как", "уточни если что", "спроси если непонятно", or runs /task-brief. Not for a change describable in one sentence.
---

# Task brief

No implementation until the brief is approved; a change describable in one
sentence skips this skill entirely. `rules/core.md` gates still hold; once work
starts, the stack skill carries the rules.

## Trigger

- Fires when two or more hold: more than one module or layer touched; a new
  subsystem, data model, integration or migration; no file or place named; no
  acceptance criterion; no boundary (what stays out); intent spread over
  several sentences with no structure.
- Does not fire: a bug with an error and a location; a diff the user could
  describe in one line; a prompt that already has the sections below.
- First line of the reply names why it fired, in Russian: `Задача крупная:
  <причина> — собираю бриф.` The user can wave it off.

## Reason before asking

1. Restate the goal as a result the user will see, one sentence. Can't →
   that is the first question.
2. Read what the task touches: `tokensave_context` / `rag_search` on the
   affected area, `tokensave_callers` on symbols that change,
   `tokensave_session_recall` for earlier decisions. A gap the repository
   answers is not a question.
3. List every gap and close each one of three ways: answered by code,
   the rules files or memory; defaulted to the neighbouring module's pattern (goes
   to `Допущения`); or a real fork (goes to the questions).
4. Chain the consequences: for each step ask what breaks if it is wrong —
   data, callers, auth, migration order, rollback. What breaks goes into
   `Ограничения` or `Проверка`.
5. Argue with the prompt: it contradicts the code, an existing decision, or a
   cheaper path exists → `Возражения` with the alternative. Never comply
   silently, never override silently.
6. Two approaches only when they differ in a real trade-off; recommend one.
   No menu of options for its own sake.

## Questions

- A real fork = two viable options whose consequences the code cannot settle.
  Not naming, not style, not what the neighbour already decides, not anything
  the rules files answer.
- One question tool call (`AskUserQuestion` / `question`), at most three questions, options with the recommended
  one first and marked. A second round only if an answer opened a new fork.
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

After the block, one line: `Правки — по разделам; «да» — начинаю с шага 1.`
Then stop.

## After the answer

- "да", "ок", "поехали" → step 1. A correction → rewrite the touched sections
  only, reprint just them, wait again.
- The brief is the spec: one step, one commit (`rules/core.md` commit trigger). A
  step that turns out different from the brief → one line saying so before
  continuing, not after.
- The brief lives in chat only; `handoff` carries it across sessions. An
  architectural choice made here → `tokensave_record_decision`.
