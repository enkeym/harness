---
name: test-conventions
description: "Test conventions for the user's TypeScript projects (Jest/Vitest, NestJS TestingModule, supertest, Testing Library, Playwright e2e and visual regression) — what to assert, file structure and naming, mocking boundaries, clean output, focused runs. Load before writing, fixing or reviewing tests in any stack, unit or e2e — including one test on a named symbol or file (\"напиши тест на X\"), which needs no test-coverage run."
---

# TypeScript test conventions

Cross-stack rules with the stack specifics inline; `nestjs-backend` and
`react-frontend` point here and add nothing of their own. Which tests a diff
or branch still needs: `test-coverage`.

## What to test
- Behaviour through the public interface: input → result, dependency called
  with the right args, error thrown. Not private methods, not call order.
- Per function: normal case, a boundary (empty, zero, max), the error. A bug
  fix starts with the test that reproduces it.
- A test that cannot fail (mock returns exactly what is asserted) is not a
  test. Check it goes red against a broken implementation.

## Structure
- File beside the code: `x.service.spec.ts`, `X.test.tsx`. `describe` per
  symbol; `it` reads as an assertion: `it('returns 404 when user is missing')`.
- Arrange / Act / Assert separated by blank lines; shared setup in `beforeEach`.
- Factories (`makeUser(overrides)`) over long literals; fixtures in
  `__fixtures__` or `test/`, whichever the project uses.

## Mocks
- Mock boundaries only: network, DB, filesystem, time (`jest.useFakeTimers` or
  injected clock), external SDKs. Never internal project modules.
- NestJS: `Test.createTestingModule({ providers: [Service, { provide: Repo, useValue: mock }] })`;
  e2e = real `INestApplication` with `main.ts` pipes/filters + `supertest`.
- React: mock the API client and timers, not the component's own hooks; query
  by role and text; `userEvent` over `fireEvent`.

## Playwright e2e
- Read the package's `playwright.config.*` first
  ([../shared/project-facts.md](../shared/project-facts.md)): specs go into its
  `testDir`, shared setup beside the existing fixtures. A specialised suite
  (visual regression) gets its own config file.
- Run via the package script that wraps Playwright when one exists — the config
  or script may bring up its own dev server and env flags; bare `npx playwright
  test` only when no script does.
- Keep the config's `workers` / `fullyParallel` as they are; serial is usually
  deliberate (one shared server or canvas).
- Retries only on CI. A spec needing a local retry is broken, not slow.
- Read the trace before editing a failed test.
- Wait with web-first assertions and `page.waitForResponse`; never
  `waitForTimeout`.
- Locators by role, text, `getByTestId` — no CSS chains tied to layout.
- Visual regression: snapshots committed; `--update-snapshots` only for an
  intended visual change, reviewed as part of the diff.
- Playwright MCP tools (`browser_*`) are for exploring a live page by hand
  (`test-browser`), not for running the suite.

## Running
- While writing: only the touched file with the package's runner (Jest:
  `path -t 'name'`, Vitest: `run path`). Full suite once before the commit.
- Clean output: no `console.error`, no `act` warnings, no open handles.
- Flakiness fixed with determinism (fake timers, explicit `await`), never retries.

## Never
- Bend an expectation to current wrong behaviour — leave it red, report, and
  don't commit the red suite (`git-flow`).
- Change production code for testability silently — describe what must change
  and hand it over.
- Test the library (`class-validator` validates an email) — only your logic on top.
