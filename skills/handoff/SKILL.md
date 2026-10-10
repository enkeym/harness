---
name: handoff
description: "Hands the thread to a fresh session — a snapshot of the task written into the plan file and `ExitPlanMode` in Claude Code, a pasted chat block in OpenCode. Load when the context meter names it, on /handoff, or when the user says \"передай в новую сессию\", \"контекст кончается\"."
---

# Handoff

Trigger: in Claude Code two hooks fire at the token thresholds in
`~/.ai-hooks/context-core.mjs` — `context-meter.mjs` between turns,
`context-step.mjs` mid-turn. `SOFT` offers the move through the menu, `HAND`,
`HARD` the handoff — only while work continues (a plan step, a check); a closed
task or one small edit is finished here with a result line. OpenCode: only
`/handoff` or the user's words. Don't raise context size yourself. Never start
a new session; write only the `task-brief` plan file and plan mode's plan file.

Mid-turn the answer is never cut in half: finish the step in hand, then, while
work continues, end the turn with the handoff, not a summary — also when the
edits were reverted; the step not started goes first under `Дальше`. A
session that has changed nothing gets no handoff at `SOFT` — the next one
would re-read the same and hit the same threshold. From `HAND` it delivers its
conclusion, then one question: move (recommended) or stay; a move carries
conclusions only (`Решения`, `Открытые вопросы`, `Дальше`) and the files the
next step needs. The hook says which case it is; follow its wording.

## Steps

1. Finish the unit of work, tests green. If finishing costs another ~30k
   tokens, hand off now with the unfinished state stated honestly.
2. One question tool call (`AskUserQuestion` / `question`) before the
   snapshot: the questions still waiting for the user, and, with uncommitted
   changes, whether to commit and push the step or hand them off as they are
   — the user often runs `/handoff` mid-work they mean to finish themselves.
   Answers go under `Решения`, the tree state under `Состояние`. A question
   left only in the snapshot hangs unanswered.
3. Pick the form: Claude Code → **plan form**, with or without a `task-brief`
   plan; OpenCode → **chat form**.
4. Plan form, in this order — plan mode allows one write, the new file it
   names, so an old plan is edited before entering:
   1. A `task-brief` plan exists → tick the steps whose commits landed,
      rewrite a step that changed (a user's correction too), no new sections.
   2. `EnterPlanMode`; write the snapshot below into the file its prompt
      names, `Дальше` pointing at the old plan and its first unticked step,
      or naming the next step itself when there is no plan; name the next
      step in one line at the top of `## Состояние`. A snapshot already in
      the file (often the brief's file) is replaced, never kept below as
      `Состояние (прежнее)`, `устарело`, `что сделано в N`.
   3. `ExitPlanMode` — its dialog is where the user clears the context and
      continues; print nothing after it.
5. Chat form: print the snapshot as one fenced ```markdown block, then one
   line: ready to copy into a new session (`/new`). Either form is stale
   after the next commit — rerun `/handoff`, don't trust the old one.

## Snapshot (Russian, only sections that apply)

- Rebuilt from scratch, ≤3000 characters: the next session re-pays the plan
  file on every request. A landed step is one hash under `Состояние`.
- Absolute dates (`9 сентября 2026`), not relative ones. Exact symbol names,
  not vague references.
- Inside a user-invoked command → `Дальше` is an action, never a bare
  `/review`: `Read ~/.claude/skills/review/SKILL.md, продолжить на !<iid>`.

```markdown
## Задача
Что делаем и зачем — 2-3 строки в терминах результата.

## Состояние
Ветка, что закоммичено, что в рабочем дереве, тесты зелёные или нет.

## Решения
Выбранное и отвергнутое — с причиной, чтобы отвергнутое не пробовали снова.

## Карта
Указатели `src/foo/bar.ts:handleX` только для оставшихся шагов, не содержимое.

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
Только то, что пользователь отложил в меню вопросов, — с его словами.
Когда и чем спросить: «после шага N — через меню».
```

## Never include

Dialogue retelling; file contents, diffs, command output, stack traces;
anything one command restores (`git status`, `git log`, a signature); secrets.
Data — dumps, logs, result tables past a few rows: write a file, name the
path; the next session reads only its totals (`paste-guard.mjs` blocks an
oversized prompt). Committed steps and their checks. What outlives the
task — what the product is, stack, build and install commands — goes to the
project's `CLAUDE.md`, loaded every session.

## Receiving a handoff

A plan file with `## Состояние`, or a pasted block — the same rules. Treat it
as a snapshot: verify `git status`, branch, tests before relying on it. Don't
echo it back. Repository beats snapshot — say so in one line, continue.

Start from the snapshot, not from a fresh survey — re-reading everything it
already names is what makes a split session cost more than the long one it
replaced:

- Plan form → the snapshot is in context after the dialog; the old plan it
  links under `Дальше` is `Read` only when a step in it is next (outside the
  repository, no router applies). Chat form naming a plan file
  → it is in context through the `@` in the first prompt; missing there →
  `Read` it before anything else. Either way steps come from the plan, state
  from the snapshot; the snapshot wins on state, the plan on steps.
- `Дальше` inside a user-invoked command (`/review`, `/commit`) → `Read` its
  SKILL.md and continue; never ask the user to retype it — the Skill tool
  can't call it, and the user's call already started the run.
- Read what `Карта` names for the first step — symbols through `body`, not
  whole files in ranges; the rest stays a pointer until a step needs it.
- Don't re-run what `Проверено` lists. Re-check one of its lines only when the
  work changes that behaviour again, or when `git status` contradicts it —
  then say which line and why.
- A blocked or contradicted line in `Проверено` is a finding: report it in one
  line instead of quietly redoing the whole check.
- A pending user decision in the snapshot ("ждёт проверки пользователем",
  "ждать «ок»") is asked through the question tool when its step is
  reached, never written as a closing line of text. "Повторно не спрашивать"
  means don't re-ask what the user already answered; it never cancels the menu
  for a decision still open.
