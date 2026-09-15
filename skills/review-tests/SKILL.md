---
name: review-tests
description: "Test-gap procedure for a diff or a whole branch — inventory of changed behaviour (exported symbols, endpoints, components, migrations), a case matrix per behaviour, matching against existing tests, changed-lines coverage, a red-check that every new test can fail, and a behaviour → test report. Load before opening a merge request, when asked \"покрой тестами\", \"напиши тесты на ветку\", \"допиши тесты\", \"что не покрыто\", and for the one-line gap check before every commit."
---

# Test review

Every changed behaviour ends with a test that fails without it, or with a
stated reason it has none. How a test is written (structure, mocks, Playwright
config, runs) is `testing-ts` — load it first; this skill decides what to write.

## Scope

- Before a commit: the gap check only — step 1 and 3 on `git diff HEAD`, then
  one line: `Без теста: <поведение> — <path>` or nothing. No tests written.
- Before a merge request or on request: the full procedure on
  `git diff <base>...HEAD`, base = `git merge-base dev HEAD` or the fork branch.
- A path or symbol named by the user narrows the scope to it.

## Procedure

1. **Inventory.** From the diff, list behaviours, not files: an exported
   function or method, an endpoint (method + route + guard), a component state,
   a hook result, a DTO rule, a migration, a query with new filters. Changed
   signature or contract → `tokensave_callers`: a caller whose behaviour
   changed is in the inventory too.
2. **Case matrix** per behaviour — only the rows that apply:
   | Row | Covers |
   | --- | --- |
   | normal | the documented result |
   | boundary | empty, zero, one, max, last page, exact limit |
   | invalid input | DTO rejection, schema error, wrong type, unknown enum |
   | not found | null lookup, deleted entity |
   | access | anonymous → 401, other owner → 403/404, role allowed |
   | failure | dependency throws, request fails, timeout |
   | state (UI) | loading, empty, error, disabled while submitting |
   | side effect | event emitted, row written, cache invalidated — or not on failure |
   | regression | the bug a `fix` commit names, reproduced first |
3. **Match.** Search existing specs for each row (`tokensave_search` on the
   symbol inside `*.spec.ts`/`*.test.tsx`, then grep the route or text). Covered
   → mark it, don't duplicate. Partly covered → extend that `describe`.
4. **Pick the level** — the lowest that proves the row: pure logic → unit;
   DI, guards, pipes, DB query → Nest e2e with `supertest`; component state →
   Testing Library; a flow across pages → Playwright spec. One row, one level.
5. **Write** the missing rows by `testing-ts`, beside the neighbours' specs.
6. **Red-check** each new test: break the line it guards (flip the condition,
   return early, drop the guard), run that file, confirm red, restore, confirm
   green. A test that stays green is rewritten or deleted.
7. **Coverage of changed lines** with the project's runner:
   `npx jest --coverage --changedSince=<base>` or
   `npx vitest run --coverage --changed <base>`. An uncovered changed branch →
   back to step 2 or a reason in the report. Coverage percent is not the goal.
8. **Run** the touched spec files, then the full suite once. Red on existing
   tests → report, never bend the expectation (`testing-ts`).
9. UI in the diff → offer `browser-qa` in one line.

## Not tested

- Types, interfaces, re-exports, constants, config, generated code, styles.
- Library behaviour: `class-validator` rejecting an email, router matching.
- Private helpers already exercised through a tested public path.
- Code the diff only moved or renamed with no behaviour change (existing specs
  still pass = covered).

## Production code

- Untestable without a change (hidden `new`, global time, module-level state)
  → describe the change and ask; never refactor silently.
- A row that exposes a real bug → leave the test red, report it under
  `Найдено`, don't fix inside the test task unless asked.

## Output

```
Тесты: <scope — ветка/дифф/путь>

| Поведение | Случаи | Тест | Статус |
| --- | --- | --- | --- |
| <symbol или METHOD /route> | <строки матрицы> | <path:describe> | новый / дописан / уже был / без теста: <причина> |

Red-check: <n из n падают без реализации>
Покрытие изменённых строк: <непокрытые места с причиной | нет>
Найдено: <баги, которые вскрыли тесты | нет>
Прогон: <команда> → <passed/failed>
```

Empty section = `нет`.
