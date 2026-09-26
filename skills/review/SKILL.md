---
name: review
description: "Reviews a colleague's branch or merge request without touching the code — runs the review-standards and review-security passes, prints every finding in chat with the current code, the fix as code, the explanation and a ready-to-paste GitLab comment, then offers to fix selected findings in the checked-out branch through the question menu. User-invoked as /review."
disable-model-invocation: true
allowed-tools: Bash(git status:*), Bash(git branch:*), Bash(git rev-parse:*), Bash(git log:*), Bash(git diff:*), Bash(git show:*), Bash(git fetch:*), Bash(git grep:*), Bash(git merge-base:*), Bash(git remote:*), Read
argument-hint: "[branch | !MR-iid | path] [focus, in your own words]"
---

# /review

Report first, edit never — until the user picks fixes in the closing menu.
The checks are `review-standards` and `review-security`; this skill replaces
their step 6 (triage with edits) and their Output sections, nothing else.

## 1. Target

Base branch and remote: [../shared/project-facts.md](../shared/project-facts.md).

| `$ARGUMENTS` | Ref | Diff |
|---|---|---|
| empty | `HEAD` + working tree | `git diff $(git merge-base <base> HEAD)` + `git status --short` |
| `<branch>` | `git fetch origin <branch>` → `origin/<branch>` | `git diff <base>...origin/<branch>` |
| `!<iid>` or an MR URL | `git fetch origin merge-requests/<iid>/head` → `FETCH_HEAD` (GitHub: `pull/<n>/head`) | `git diff <base>...FETCH_HEAD` |
| a path | `HEAD` | the empty-row diff limited to that path |

- No checkout, no stash, no switch: the user's working tree stays as it was.
- Ref other than `HEAD`: read files as `git show <ref>:<path>`, search as
  `git grep -n <name> <ref>`. The tokensave graph shows the checked-out tree —
  use it for callers outside the diff only, and say so in one line.
- MR: its target branch is unknown without the API — diff against the
  resolved base and name it in the header line; the user corrects it in words.
- Free words after the target are the focus: check them first, still run the
  full pass.
- Header line before the pass: target, base, `git log --oneline <base>..<ref>`
  count, `--stat` totals.

## 2. Pass

1. Load `review-standards`, `review-security`, the stack skill for every
   touched area (`rules/core.md` Skills table), `test-conventions` when the
   diff has tests.
2. Run both procedures through their checklists, steps 1–5: impact, regression,
   depth, secrets, missing controls. Every finding verified by search or by
   reading the caller — a guess is not reported.
3. No edits of any kind — not even a certain one-line fix. `tsc`, linter and
   tests only when the target is `HEAD`; otherwise list them in the
   not-checked line of the summary.
4. A secret in the diff → report it first, as a Critical that needs key
   rotation, not just deletion; continue the pass.

## 3. Report

Findings numbered, Critical → Important → Minor, merged across both skills
(one finding per defect, not per skill). Per finding:

~~~
### <N>. <Critical | Important | Minor> — <суть в 3–6 словах>
`<path>:<line>`

**Проблема.** <что не так и почему: вход или состояние → что сломается, кого
затронет>. <Правило проекта или соседний код, на который опираешься>.

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
> ```suggestion:-<строк выше>+<строк ниже>
> <готовая замена>
> ```
~~~

- The fix covers every line it changes; a fix spanning several files or a
  design choice → code of the key part plus one line on the rest, no
  `suggestion` block.
- `suggestion` only when the replacement sits on lines of the diff; GitHub
  remote → plain ` ```suggestion `. Otherwise a plain code block.
- MR comment text: neutral, addressed to the change, not the person; no mention of AI, a model or a tool — it goes out under the
  user's name.
- Minor findings: one line each, no code blocks, comment included.

After the findings:

```
Итог: approved | changes requested — Critical <n>, Important <n>, Minor <n>
Проверено без замечаний: <категории>
Не проверено: <что и почему — тесты не запускались, нужен контекст задачи>
```

Empty section = "нет". Nothing found → the summary block only.

## 4. Menu

One `AskUserQuestion` / `question` call after the report; none when nothing
was found. Question and options, recommended first:

```
Что делаем с находками?
- Только ревью, ничего не менять (Recommended)
- Собрать комментарии одним блоком
- Исправить выбранные
- Исправить все
```

- Target is another ref: drop both fix options — editing needs the branch
  checked out, which the user does.
- Fix selected → a second question, `multiSelect`: one option per finding
  when ≤4, otherwise severity groups (all Critical; Critical and Important),
  single numbers through "Other".
- Collect comments → every MR comment as `<path>:<line>` + its text, in one
  block, ready to paste one by one.
- Chosen fixes: apply exactly the fix shown, nothing beyond it; then `tsc`,
  linter and tests of the touched module with real output. No commit, no
  push — the branch is a colleague's; `/commit` is the user's call.
