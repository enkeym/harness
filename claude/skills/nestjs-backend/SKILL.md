---
name: nestjs-backend
description: NestJS/TypeScript server conventions — module layout, DI, DTOs and validation, exceptions, config, database, tests. Load before writing or reviewing any server-side code: module, controller, service, provider, DTO, entity or schema, guard, interceptor, migration, or a Nest test.
---

# NestJS backend conventions

The project outranks this list: copy a neighbouring module first
(`tokensave_context` scoped to the server). Read
[../shared/code-rules.md](../shared/code-rules.md) (types, reuse,
KISS/SOLID/DRY) before the first edit; this file adds only Nest structure.

## Structure
- One module per domain: `x.module.ts`, `x.controller.ts`, `x.service.ts`,
  `dto/`, `entities/` or `schemas/`, `x.service.spec.ts` beside the code.
- Thin controller: parse input, call service, map response. Service knows
  nothing about HTTP.
- Dependencies only via constructor DI. No `new Service()`, no import around
  another module's `exports`.
- Shared guards, interceptors, pipes, filters, decorators in `common/`.

## Input and output
- Input = DTO class with `class-validator`/`class-transformer` behind a global
  `ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true })`.
  Numeric params via `ParseIntPipe` or `@Type(() => Number)`.
- Output = interface/class with explicit fields; an entity never leaves whole;
  sensitive fields excluded in the mapping.

## Errors
- Expected failures → `HttpException` subclasses; client text carries no
  internal detail.
- Unexpected ones not caught; the global filter handles them. `try/catch` only
  with a meaningful reaction.
- `Logger` from `@nestjs/common` with class context. No tokens, passwords,
  payment bodies in logs.

## Config
- Environment only via `ConfigService`, schema validated at startup. Never
  `process.env` in module code.
- New variable → `.env.example` in the same change (name + comment, no value).

## Database
- Transaction wherever more than one entity changes together.
- Parameterised queries; no string concatenation in SQL.
- Migrations are separate reversible files; no `synchronize` on production.

## Tests
- Unit: `Test.createTestingModule` with deps mocked via `useValue`; assert
  result, repository args, thrown exception — not internal steps.
- e2e: `supertest` against `INestApplication` with the same global pipes and
  filters as `main.ts`. Rest is in `testing-ts`.
