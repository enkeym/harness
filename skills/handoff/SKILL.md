---
name: handoff
description: "Hands the thread to a fresh session when the context grows expensive. In Claude Code with a task-brief plan file it updates the plan (ticked steps, a `## Состояние` snapshot) and leaves through `ExitPlanMode`, whose dialog offers to clear the context and continue from the plan — nothing to copy. Without a plan, or in OpenCode, it prints a handoff block in chat that the user pastes into a new session. Covers what belongs in the snapshot, what never does, and what the next session must not re-verify. Load when the context meter asks for a handoff, when the user runs /handoff, or says \"передай в новую сессию\", \"контекст кончается\"."
---

# Handoff

Trigger: in Claude Code two hooks fire at the token thresholds in
`~/.ai-hooks/context-core.mjs` — `context-meter.mjs` between turns,
`context-step.mjs` mid-turn, between tool calls. `SOFT` closes the step with no
handoff yet; `HAND` and `HARD` ask for one. OpenCode has no meter — only
`/handoff` or the user's words. Don't raise context size again yourself. Never
create a file, never start a new session for the user; the only write is into
an existing `task-brief` plan file.

Mid-turn the answer is never cut in half: finish the step in hand, commit and
push it, and only then hand off — the step not started goes first under
`Дальше`. A session that has changed nothing gets no handoff at `SOFT`: it
would list what was read, the next session would read the same and hit the
same threshold. From `HAND` such a session is usually an analysis, not a
prelude to an edit — its handoff is built from conclusions (`Решения`,
`Открытые вопросы`, `Дальше`), with nothing under `Карта` beyond the files the
next step needs. The hook says which case it is; follow its wording.

## Steps

1. Finish the unit of work: commit, tests green. If finishing costs another
   ~30k tokens, hand off now with the unfinished state stated honestly.
2. Pick the form:
   - Claude Code and a `task-brief` plan file exists → **plan form**: the
     file carries everything, no chat block.
   - No plan file, or OpenCode → **chat form**.
3. Plan form: `EnterPlanMode`, then in the plan file tick the steps whose
   commits landed, rewrite a step that changed, and replace (or add before
   `## Шаги`) one `## Состояние` section holding the snapshot sections below
   except `Задача` and `Дальше` — the plan already states both; name the next
   step in one line at the top of `## Состояние`. Then `ExitPlanMode` — its
   dialog is where the user clears the context and continues; print nothing
   after it. Stale after the next commit — rerun `/handoff`.
4. Chat form: print the snapshot as one fenced ```markdown block. After it,
   one line: ready to copy into a new session (`/clear` in Claude Code, `/new`
   in OpenCode) once copied. Stale after the next commit — rerun `/handoff`,
   don't trust the old one.

## Snapshot (Russian, only sections that apply)

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
План: `@~/.claude/plans/<slug>.md`, следующий — шаг N. Без плана — следующий
шаг первым пунктом, конкретным действием. Никогда копия шагов плана.

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

## Receiving a handoff

A plan file with `## Состояние`, or a pasted block — the same rules. Treat it
as a snapshot: verify `git status`, branch, tests before relying on it. Don't
echo it back. Repository beats snapshot — say so in one line, continue.

Start from the snapshot, not from a fresh survey — re-reading everything it
already names is what makes a split session cost more than the long one it
replaced:

- Plan form → the plan is in context after the dialog; steps and state both
  come from it, the first unticked step is next. Chat form naming a plan file
  → it is in context through the `@` in the first prompt; missing there →
  `Read` it before anything else (outside the repository, no router applies).
  Steps come from the plan, state from the block; the block wins on state,
  the plan on steps.
- Open only the files the first step touches. The rest of `Карта` stays a
  pointer until a step needs it.
- Don't re-run what `Проверено` lists. Re-check one of its lines only when the
  work changes that behaviour again, or when `git status` contradicts it —
  then say which line and why.
- A blocked or contradicted line in `Проверено` is a finding: report it in one
  line instead of quietly redoing the whole check.
