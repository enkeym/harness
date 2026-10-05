# /review — report and menu

Contents: Report · MR comments · Finding · Summary · Menu.

## Report

Two parts, nothing before, between or after them: the report in plain chat
markdown — for reading, the terminal renders it; the menu. No preamble on
what was run — that goes to the summary.

~~~
**Ревью: <режим из строки-заголовка>**

🔴 **Critical**

<блоки находок>

🟠 **Important**

<блоки находок>

🟡 **Minor**

<список>

**Итог**

<сводка>
~~~

A severity with no findings — its title line is dropped.

## MR comments

One per finding, Minor included, in number order — the body of a draft note
(*Drafts* of [gitlab.md](gitlab.md)). In chat only when the drafts cannot be
sent: the comments and nothing else — no header, severity titles, verdict,
checked or not-checked lines — one fence per comment, so each is copied whole
into its GitLab line or a Telegram message. The anchor line sits above the
fence, never inside it; four backticks keep the inner ` ``` ` blocks inside:

~~~
**<N>.** `<path>:<line>`
````markdown
<1–3 предложения: проблема и последствие, без оценок автора>
Как воспроизвести: <шаги одной строкой>
```suggestion:-<строк выше>+<строк ниже>
<готовая замена>
```
````

**<N>.** `<path>:<line>`
````markdown
<…>
````
~~~

- Plain lines inside, no `>` prefix; the fence holds exactly the comment text.
- Text: neutral, addressed to the change, not the person; no mention of AI, a
  model or a tool — it goes out under the user's name. `Как воспроизвести`
  only when the manual check fits one line.
- `suggestion` only when the replacement sits on lines of the diff; GitHub
  remote → plain ` ```suggestion `. Otherwise a plain code block; a fix
  spanning several files or a design choice → no code block.
- Markup inside a fence only what both Telegram and GitLab render:
  `**bold**`, inline code, ` ``` ` fences with a language, plain `-` and `1.`
  lists, emoji. No `#` headings, `>` quotes, `---` rules, tables, markdown
  links, `*`/`_` italics — Telegram shows them as raw characters. Identifiers, paths and anything with
  `_` or `*` always in backticks: bare `__init__` turns italic in Telegram.

## Finding

One block per finding, Critical and Important:

~~~
**<N>. <суть в 3–6 словах>**
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
~~~

- Manual check: steps the user runs as written on a local or dev stand, never
  prod; a security payload is harmless (`<b>x</b>`, a second test user's id).
  A defect no action shows (race, type hole, dead branch) → a static check:
  the `path:line` to open, what to compare it with, or a command and its
  expected output. "Убедитесь, что …" without the how is not a step.
- The fix covers every line it changes; a fix spanning several files or a
  design choice → code of the key part plus one line on the rest.
- The MR comment is not repeated here.
- Minor findings: one list item each, no code blocks, the path in backticks —
  `- <N>. <path>:<line> — проблема — проверка`.

## Summary

~~~
- **Итог:** approved | changes requested — Critical <n>, Important <n>, Minor <n>
- **Проверено без замечаний:** <категории>
- **Стиль проекта:** <файл стиля> | файла стиля нет
- **Не проверено:** <что и почему — тесты не запускались, нужен контекст задачи>
~~~

Empty section = "нет". Nothing found → the summary only, no menu, no drafts.

## Menu

One `AskUserQuestion` / `question` call after the summary, recommended first.

The user's branch:

```
Исправить находки?
- Исправить все (Recommended)
- Исправить выбранные
- Не исправлять
```

A colleague's:

```
Что делаем с находками?
- Только ревью — черновики в MR (Recommended)
- Исправить выбранные
- Исправить все
```

- Target is another ref: no fix options, so no menu — a colleague's branch
  goes straight to Only review.
- Only review → *Drafts* of [gitlab.md](gitlab.md) into the MR of
  *Current branch with an open MR*; no MR fits → the MR comments in chat,
  one line why. MR mode (1.2) has no menu at all.
- Не исправлять → one line, no recap of the report.
- Fix selected → a second question, `multiSelect`: one option per finding
  when ≤4, otherwise severity groups (all Critical; Critical and Important),
  single numbers through "Other".
- Chosen fixes: apply exactly the fix shown, nothing beyond it; never
  `git add` — in the soft-reset flow the colleague's change is staged and the
  fix stays unstaged, so VS Code shows them apart. Then `tsc`, linter without
  fix flags and tests of the touched module with real output. No commit, no
  push — `/commit` is the user's call.
