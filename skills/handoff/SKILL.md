---
name: handoff
description: "Assembles a handoff block in chat when the context grows expensive — what belongs in it, what never does, and what the next session must not re-verify. No files are written; the user copies the block into a fresh session. Load when the context meter asks for a handoff, when the user runs /handoff, or says \"передай в новую сессию\", \"контекст кончается\"."
---

# Handoff

Trigger: in Claude Code two hooks fire at the token thresholds in
`~/.ai-hooks/context-core.mjs` — `context-meter.mjs` between turns,
`context-step.mjs` mid-turn, between tool calls. `SOFT` closes the step with no
block yet; `HAND` and `HARD` ask for the block. OpenCode has no meter — only
`/handoff` or the user's words. Don't raise context size again yourself. Never
write a file, never start a new session for the user.

Mid-turn the answer is never cut in half: finish the step in hand, commit and
push it, and only then print the block — the step not started goes first under
`Дальше`. A session that has changed nothing gets no block at `SOFT`: it would
list what was read, the next session would read the same and hit the same
threshold. From `HAND` such a session is usually an analysis, not a prelude to
an edit — its block is built from conclusions (`Решения`, `Открытые вопросы`,
`Дальше`), with nothing under `Карта` beyond the files the next step needs.
The hook says which case it is; follow its wording.

## Steps

1. Finish the unit of work: commit, tests green. If finishing costs another
   ~30k tokens, hand off now with the unfinished state stated honestly.
2. Print the block as one fenced ```markdown block. After it, one line: ready
   to copy into a new session (`/clear` in Claude Code, `/new` in OpenCode) once
   copied. Stale after the
   next commit — rerun `/handoff`, don't trust the old one.

## Block (Russian, only sections that apply)

- Absolute dates (`9 сентября 2026`), not relative ones. Exact symbol names,
  not vague references.

```markdown
## Задача
Что делаем и зачем — 2-3 строки в терминах результата.

## Состояние
Ветка, что закоммичено, что в рабочем дереве, тесты зелёные или нет.

## Решения
Выбранное и отвергнутое — с причиной.

## Карта
Файлы и символы указателями: `src/foo/bar.service.ts:handleX`. Не содержимое.

## Проверено
Что уже прогнано и чем: `impact` по `handleX` — затронуты `a.ts:useY`,
`b.ts:mapZ`, оба поправлены; тесты `foo.spec.ts` зелёные. Что осталось
непроверенным — отдельной строкой.

## Неявные связи
Строки из карты проекта (`docs/links/`), задетые этой работой, плюс найденные
по ходу и ещё не записанные туда.

## Дальше
Следующий шаг первым пунктом, конкретным действием.

## Открытые вопросы
Только то, что ждёт человека.
```

## Never include

Dialogue retelling; file contents, diffs, command output, stack traces;
anything one command restores (`git status`, `git log`, a signature); secrets.
Data of any kind — DB dumps, JSONL records, logs, result tables past a few
rows: write them to a file and name the path; the next session processes the
file with a script and reads only the totals. `paste-guard.mjs` blocks a
prompt above its size limit, and one pasted dump costs more than the whole
session's base context. Architectural decisions go to
`tokensave_record_decision`, not here.

## Receiving a block

Treat it as a snapshot: verify `git status`, branch, tests before relying on
it. Don't echo it back. Repository beats block — say so in one line, continue.

Start from the block, not from a fresh survey — re-reading everything it
already names is what makes a split session cost more than the long one it
replaced:

- Open only the files the first step of `Дальше` touches. The rest of `Карта`
  stays a pointer until a step needs it.
- Don't re-run what `Проверено` lists. Re-check one of its lines only when the
  work changes that behaviour again, or when `git status` contradicts it —
  then say which line and why.
- A blocked or contradicted line in `Проверено` is a finding: report it in one
  line instead of quietly redoing the whole check.
