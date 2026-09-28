---
name: test-browser
description: "Manual QA of a running web app through Playwright MCP — every change of the branch as a browser scenario, console and network errors, a bug report with reproduction steps. User-invoked as /test-browser."
disable-model-invocation: true
argument-hint: "[URL, page or flow to narrow the pass]"
---

# /test-browser

Click what a user would click and report only what was seen in the browser.
Runs only on this command — never offered or started by another skill. Project
memory that forbids browser QA wins: say so in one line and stop. Spec
conventions are `test-conventions`.

## Setup

1. Resolve the base branch by [../shared/project-facts.md](../shared/project-facts.md).
2. App running? Dev port from `package.json` scripts or `playwright.config.*`
   (`webServer.url`). Not running → start it the project's way in the
   background; none found → ask for the URL.
3. Login and data: the seed or test account the project documents
   (`.env.example`, e2e fixtures, README). Never a real user's credentials,
   never production.

## Branch inventory

`$ARGUMENTS` names a page or flow → only that; skip to *Scenarios*.
Otherwise every change of the branch gets a scenario:

1. `git log --no-merges --format='%h %s' <base>..HEAD`,
   `git diff <base>...HEAD --stat`, plus `git status --short` for
   uncommitted work.
2. Group commits into entities the user sees (page, panel, dialog, form) the
   way `git-flow` does; find each entity's route and UI labels from the diff.
3. Add the cases already written for the branch: e2e specs and `it(...)`
   titles in the diff, `Проверить:` lines of an MR text in this session.
4. Print the plan before the first click:
   ```
   План: <n сценариев> по <base>..HEAD
   | Коммит | Сущность → экран | Сценарий |
   ```
5. Coverage check: every commit has a row or `без UI: <причина>`. An unmapped
   commit → add a row. Nothing starts until the table is complete.

## Scenarios per screen

Only the rows the screen has:

- Main path end to end, as the role that uses it.
- Forms: empty submit, each field invalid, max length, paste with spaces,
  double submit, submit disabled in flight, error beside the field, values kept
  after a server error.
- States: loading, empty list, request failed (block with
  `browser_run_code_unsafe` + `page.route` only when the user allows it), not
  found, no permission.
- Navigation: back/forward, reload on a deep link, direct URL without login.
- Keyboard: Tab order, visible focus, Enter submits, Esc closes a modal, focus
  returns after closing.
- Width: `browser_resize` to 375×812 and 1280×800 — no horizontal scroll,
  nothing overlapped or cut.
- Content: long names, Cyrillic, zero and huge numbers, missing image.

## Procedure

1. `browser_navigate` → `browser_snapshot`; act by the `ref` of the latest
   snapshot, a new snapshot after every navigation or DOM change.
2. After each scenario: `browser_console_messages` (errors, warnings) and
   `browser_network_requests` (4xx/5xx, duplicate calls).
3. `browser_take_screenshot` only as evidence of a visual bug.
4. Wait with `browser_wait_for` on text or disappearance, never a fixed delay.
5. A bug: reproduce once more from a clean load before reporting.
6. Read-only toward data you did not create; delete what you created.
7. Finish with `browser_close`.

## Never

- Guess a bug from code while the browser shows otherwise — the browser wins.
- Fix the bug inside this pass unless asked.
- Submit payments, send real messages or emails, change shared accounts.
- Write a spec without the user's yes; selectors then by role and label, not refs.

## Output

```
QA: <URL> — <base>..HEAD — <сценарии: n пройдено, n с багами>

Покрытие ветки: <n коммитов → n сценариев; без UI: <коммиты> | нет>

Баги:
1. <Экран → элемент> — <что не так>
   Шаги: <1…n>
   Ожидалось: <…>  Получилось: <…>
   Консоль/сеть: <ошибка или запрос со статусом | нет>

Проверено без замечаний: <сценарии одной строкой>
Не проверено: <что и почему>
Предлагаю в e2e: <сценарии | нет>
```

Empty section = `нет`.
