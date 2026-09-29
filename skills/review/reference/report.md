# /review — report and menu

## Report

The whole report — findings and summary — sits in one fence of four
backticks, so the inner ` ``` ` blocks stay inside it; the menu comes after
the fence. Nothing before or after it but the header line and the menu.

~~~
````markdown
# Ревью: <режим из строки-заголовка>

## Critical
<блоки находок>
## Important
<блоки находок>
## Minor
<список>
## Итог
<сводка>
````
~~~

A severity with no findings — its heading is dropped.

## Finding

One block per finding, Critical and Important:

~~~
### <N>. <Critical | Important | Minor> — <суть в 3–6 словах>
`<path>:<line>`

**Проблема.** <что не так и почему: вход или состояние → что сломается, кого
затронет>. <Правило проекта или соседний код, на который опираешься>.

**Как проверить вручную:**
1. <подготовка: что запустить, какие данные, под какой ролью>
2. <действие: запрос с методом, путём и телом / путь в UI / команда>
3. <ожидается X, на деле Y — где видно: ответ, лог, строка в БД, консоль>

**Сейчас:**
```<lang>
<≤8 строк из диффа>
```

**Исправление:**
```<lang>
<исправленный фрагмент, те же строки>
```

**Комментарий в MR:**
> <1–3 предложения: проблема и последствие, без оценок автора>
> Как воспроизвести: <шаги одной строкой>
> ```suggestion:-<строк выше>+<строк ниже>
> <готовая замена>
> ```
~~~

- Manual check: steps the user runs as written on a local or dev stand, never
  prod; a security payload is harmless (`<b>x</b>`, a second test user's id).
  A defect no action shows (race, type hole, dead branch) → a static check:
  the `path:line` to open, what to compare it with, or a command and its
  expected output. "Убедитесь, что …" without the how is not a step.
- The fix covers every line it changes; a fix spanning several files or a
  design choice → code of the key part plus one line on the rest, no
  `suggestion` block.
- `suggestion` only when the replacement sits on lines of the diff; GitHub
  remote → plain ` ```suggestion `. Otherwise a plain code block.
- MR comment text: neutral, addressed to the change, not the person; no
  mention of AI, a model or a tool — it goes out under the user's name.
  `Как воспроизвести` only when the manual check fits one line.
- Minor findings: one list item each, no code blocks, the path in backticks —
  `- <N>. <path>:<line> — проблема — проверка — комментарий`.

## Summary

~~~
- **Итог:** approved | changes requested — Critical <n>, Important <n>, Minor <n>
- **Проверено без замечаний:** <категории>
- **Не проверено:** <что и почему — тесты не запускались, нужен контекст задачи>
~~~

Empty section = "нет". Nothing found → the report fence holds the summary
only, no menu.

## Menu

One `AskUserQuestion` / `question` call after the report, recommended first:

```
Что делаем с находками?
- Только ревью, ничего не менять (Recommended)
- Собрать комментарии одним блоком
- Исправить выбранные
- Исправить все
```

- Target is another ref: drop both fix options — the user checks it out.
- Fix selected → a second question, `multiSelect`: one option per finding
  when ≤4, otherwise severity groups (all Critical; Critical and Important),
  single numbers through "Other".
- Collect comments → every MR comment as `<path>:<line>` + its text with the
  repro line, in one ````` ````markdown ````` fence, ready to paste one by one.
- Chosen fixes: apply exactly the fix shown, nothing beyond it; never
  `git add` — in the soft-reset flow the colleague's change is staged and the
  fix stays unstaged, so VS Code shows them apart. Then `tsc`, linter without
  fix flags and tests of the touched module with real output. No commit, no
  push — the branch is a colleague's; `/commit` is the user's call.
