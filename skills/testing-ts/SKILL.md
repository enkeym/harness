---
name: testing-ts
description: Test conventions for the user's TypeScript projects (Jest/Vitest, NestJS TestingModule, supertest, Testing Library) — what to assert, file structure and naming, mocking boundaries, clean output, focused runs. Load before writing, fixing or reviewing tests in any stack.
---

# TypeScript test conventions

## What to test

- Behaviour through the public interface: input → result, dependency called with
  the right arguments, error thrown. Not private methods, not the order of
  internal calls.
- Per function, at minimum: the normal case, a boundary (empty, zero, max), and
  the error. A bug fix starts with the test that reproduces the bug.
- A test that cannot fail — mocks returning exactly what is asserted — is not a
  test. Check that it goes red against a broken implementation.

## Structure

- File next to the code: `x.service.spec.ts`, `X.test.tsx`. `describe` per
  symbol; `it` reads as an assertion:
  `it('returns 404 when user is missing')`.
- Arrange / Act / Assert separated by blank lines; shared setup in `beforeEach`
  rather than copied into each test.
- Data factories (`makeUser(overrides)`) instead of long literals in every test;
  fixtures in `__fixtures__` or `test/`, whichever the project uses.

## Mocks

- Mock boundaries: network, DB, filesystem, time (`jest.useFakeTimers` or an
  injected clock), external SDKs (Telegram, YooKassa). Never internal project
  modules — the test would be asserting the mock.
- NestJS: `Test.createTestingModule({ providers: [Service, { provide: Repo, useValue: mock }] })`;
  e2e uses a real `INestApplication` with the same global pipes and filters as
  `main.ts`, plus `supertest`.
- React: mock the API client, not the component's hook; query the DOM by role
  and text.

## Running

- While writing, run only the touched file:
  `npx jest path/to/x.spec.ts -t 'name'` (or `vitest run path`). The full suite
  runs once, before the commit.
- Output stays clean: no `console.error`, no `act` warnings, no open handles
  (`--detectOpenHandles` when suspected). Noise is a defect.
- Flakiness from time or ordering is fixed with determinism (fake timers,
  explicit `await`), never with retries.

## Never

- Don't bend an expectation to match current wrong behaviour — leave the test
  red and report it.
- Don't change production code for testability silently — describe what needs to
  change (inject the dependency, extract `new Date()`) and hand it over.
- Don't test the library (that `class-validator` validates an email) — only your
  own logic on top of it.
