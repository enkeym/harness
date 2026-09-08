---
name: nestjs-backend
description: NestJS/TypeScript server conventions — module layout, DI, DTOs and validation, exceptions, config, database, tests. Load before writing or reviewing any server-side code: a module, controller, service, provider, DTO, entity or schema, guard, interceptor, migration, or a Nest test.
---

# NestJS backend conventions

The project outranks this list: look at a neighbouring module first
(`tokensave_context` scoped to the server) and repeat its way. This list is for
when there is no example to copy. Global rules — no `any`, reuse before writing
new, KISS/SOLID/DRY — live in CLAUDE.md and are not repeated here.

## Structure

- One module per domain: `x.module.ts`, `x.controller.ts`, `x.service.ts`,
  `dto/`, `entities/` or `schemas/`, `x.service.spec.ts` next to the code.
- Thin controller: parse input, call the service, map the response. Logic lives
  in the service, and the service knows nothing about HTTP.
- Dependencies only through the constructor and DI. No `new Service()`, no
  importing another module's service around its `exports`.
- Shared guards, interceptors, pipes, filters and decorators live in `common/`.

## Input and output

- Input is a DTO class with `class-validator`/`class-transformer`, behind a
  global `ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true })`.
  Numeric path and query params go through `ParseIntPipe` or `@Type(() => Number)`.
- Output is an interface or class with explicit fields; a DB entity never leaves
  whole. Sensitive fields (`passwordHash`, tokens) are excluded in the mapping,
  not forgotten.
- Derived DTOs come from `PartialType`/`PickType`/`OmitType`
  (`@nestjs/mapped-types`), never from copied field lists.

## Errors

- Expected failures — `HttpException` subclasses (`NotFoundException`,
  `ConflictException`); client-facing text carries no internal detail.
- Unexpected ones are neither caught nor swallowed; the global filter handles
  them. `try/catch` only where there is a meaningful reaction.
- Log through `Logger` from `@nestjs/common` with the class context. Tokens,
  passwords and payment bodies never reach the log.

## Config

- Environment only through `ConfigService`, with the schema validated at startup
  (Joi or class-validator). Module code never reads `process.env`.
- A new variable goes into `.env.example` in the same change — name and comment,
  no value.

## Database

- A transaction wherever more than one entity changes consistently.
- Parameterised queries; no string concatenation in SQL.
- Migrations are separate reversible files; a production schema is never changed
  by `synchronize`.

## Tests

- Unit: `Test.createTestingModule` with dependencies mocked through `useValue`;
  assert behaviour — result, repository called with the right arguments,
  exception thrown — not internal steps.
- e2e: `supertest` against `INestApplication` with the same global pipes and
  filters as `main.ts`.
- Everything else about tests is in the `testing-ts` skill.

## Domain types

- Domain enumerations live once, as an `enum` or an `as const` object; string
  literals are not scattered through the code.
