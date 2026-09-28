---
name: nestjs-backend
description: "NestJS server conventions — modules, DI, DTOs and validation, exceptions, config, database. Load before writing or reviewing server code: module, controller, service, DTO, entity, guard, migration."
---

# NestJS backend conventions

The project outranks this list: copy a neighbouring module first
(`tokensave_context` scoped to the server). Read
[../shared/code-rules.md](../shared/code-rules.md) (types, reuse order,
KISS/SOLID/DRY) before the first edit; this file adds only Nest structure.
Tests are written only when asked or before an MR (`test-coverage`), never as
a side effect of a server edit.

## Structure
- One module per domain: `x.module.ts`, `x.controller.ts`, `x.service.ts`,
  `dto/`, `entities/` or `schemas/`, `x.service.spec.ts` beside the code.
- Thin controller: parse input, call service, map response. Service knows
  nothing about HTTP.
- Dependencies only via constructor DI. No `new Service()`, no import around
  another module's `exports`.
- A Nest module for the concern exists (`@nestjs/config`, `@nestjs/schedule`,
  `@nestjs/throttler`, `@nestjs/cache-manager`, `@nestjs/axios`) → use or
  propose it before a custom provider.
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
- Unexpected ones not caught; the global filter handles them.
- `Logger` from `@nestjs/common` with class context. No tokens, passwords,
  payment bodies in logs.

## Config
- Environment via `ConfigService` with a schema validated at startup.

## Database
- Transaction wherever more than one entity changes together.
- Parameterised queries; no string concatenation in SQL.
- Migrations are separate reversible files; no `synchronize` on production.

## Tests
- How: `test-conventions`, including its NestJS lines.
