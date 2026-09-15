---
name: testing-ts
description: Test conventions for the user's TypeScript projects (Jest/Vitest, NestJS TestingModule, supertest, Testing Library, Playwright e2e and visual regression) — what to assert, file structure and naming, mocking boundaries, clean output, focused runs. Load before writing, fixing or reviewing tests in any stack, unit or e2e.
---

# TypeScript test conventions

Cross-stack rules with the stack specifics inline; `nestjs-backend` and
`react-frontend` point here and add nothing of their own. Which tests a diff
or branch still needs: `review-tests`.

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
- Config and specs on the client: `client/playwright.config.ts`,
  `testDir: './e2e'`, `*.spec.ts`, shared setup in `e2e/fixtures`. A specialised
  suite (visual regression) gets its own config file.
- Run via the project script (`npm run test:e2e`), never bare `npx playwright
  test` — the config brings up its own dev server and env flags.
- Serial on purpose (`fullyParallel: false`, `workers: 1`): one server, one
  canvas. Don't enable parallelism.
- Retries only on CI. A spec needing a local retry is broken, not slow.
- Read the trace before editing a failed test.
- Wait with web-first assertions and `page.waitForResponse`; never
  `waitForTimeout`.
- Locators by role, text, `getByTestId` — no CSS chains tied to layout.
- Visual regression: snapshots committed; `--update-snapshots` only for an
  intended visual change, reviewed as part of the diff.
- Playwright MCP tools (`browser_*`) are for exploring a live page by hand
  (`browser-qa`), not for running the suite.

## Running
- While writing: only the touched file (`npx jest path -t 'name'`, `vitest run
  path`). Full suite once before the commit.
- Clean output: no `console.error`, no `act` warnings, no open handles.
- Flakiness fixed with determinism (fake timers, explicit `await`), never retries.

## Never
- Bend an expectation to current wrong behaviour — leave it red, report.
- Change production code for testability silently — describe what must change
  and hand it over.
- Test the library (`class-validator` validates an email) — only your logic on top.
