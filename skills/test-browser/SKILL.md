---
name: test-browser
description: "Manual exploratory QA of a running web app through Playwright MCP (browser_navigate, browser_snapshot, browser_click, browser_fill_form, browser_console_messages, browser_network_requests) — scenarios derived from a diff or branch, forms, empty and error states, keyboard, mobile width, console and network errors, a bug report with reproduction steps, and stable scenarios turned into Playwright specs. Load when the task is checking a running UI by hand rather than writing a spec (\"прокликай\", \"проверь в браузере\", \"протестируй UI\"), or when test-coverage offers it for a UI change."
---

# Browser QA

Click what a user would click and report only what was seen in the browser.
Spec conventions are `test-conventions`; which unit tests a diff needs is
`test-coverage`.

## Setup

1. App running? Check the dev port from `package.json` scripts or the
   Playwright config (`webServer.url`). Not running → start it the project's
   way in the background (`npm run dev`); none found → ask for the URL.
2. Test data and login: use the seed or test account the project documents
   (`.env.example`, `e2e/fixtures`, README). Never a real user's credentials,
   never production.
3. Scenarios from the change: `git diff <base>...HEAD --stat`, then the touched
   pages, routes and components. The user named a page or flow → only that.

## Scenarios per touched screen

Only the rows the screen has:

- Main path end to end, as the role that uses it.
- Forms: empty submit, each field invalid, max length, paste with spaces,
  double submit, submit disabled in flight, error beside the field, values kept
  after a server error.
- States: loading, empty list, request failed (block the request with
  `browser_run_code_unsafe` + `page.route` only when the user allows it),
  not found, no permission.
- Navigation: back/forward, reload on a deep link, direct URL without login.
- Keyboard: Tab order, visible focus, Enter submits, Esc closes a modal, focus
  returns after closing.
- Width: `browser_resize` to 375×812 and 1280×800 — no horizontal scroll,
  nothing overlapped or cut.
- Content: long names, Cyrillic, zero and huge numbers, missing image.

## Procedure

1. `browser_navigate` → `browser_snapshot`. Act by the `ref` from the latest
   snapshot; take a new one after every navigation or DOM change.
2. After each scenario: `browser_console_messages` (errors and warnings) and
   `browser_network_requests` (4xx/5xx, duplicate calls, requests fired twice).
3. Screenshot (`browser_take_screenshot`) only as evidence of a visual bug.
4. Wait by `browser_wait_for` on text or disappearance, never a fixed delay.
5. A bug: reproduce it once more from a clean load before reporting.
6. Stay read-only toward data you did not create; delete what you created when
   the UI allows it.
7. Finish with `browser_close`.

## Scenario → spec

- A scenario that passed and guards the changed behaviour → propose a
  Playwright spec; write it only when the user agrees or the task asked for e2e.
- Selectors from the snapshot's roles and names (`getByRole`, `getByLabel`),
  not refs — refs die with the page.

## Never

- Guess a bug from code while the browser shows otherwise — the browser wins.
- Fix the bug inside this pass unless asked; report it.
- Submit payments, send real messages or emails, change settings of shared
  accounts.

## Output

```
QA: <URL> — <сценарии: n пройдено, n с багами>

Баги:
1. <Экран → элемент> — <что не так>
   Шаги: <1…n>
   Ожидалось: <…>  Получилось: <…>
   Консоль/сеть: <ошибка или запрос со статусом | нет>

Проверено без замечаний: <сценарии одной строкой>
Не проверено: <что и почему — нет доступа, нет данных, нужен реальный платёж>
Предлагаю в e2e: <сценарии | нет>
```

Empty section = `нет`.
