# Code rules — TypeScript, both stacks

Read by `nestjs-backend` and `react-frontend` before the first edit and by
`review-standards` as its checklist: the stack skill adds structure, the
review adds only what a diff can show. The project's own code outranks any
line here.

## Types

- No `any`: the exact type, or `unknown` narrowed at the boundary. Same ban on
  its disguises — `as any`, `@ts-ignore`, unexplained `@ts-expect-error`, an
  untyped callback param, `!` over a real `undefined`.
- Derive, never copy: `extends`/`Pick`/`Omit`, `PartialType`/`PickType`/`OmitType`,
  `ReturnType`, `z.infer`. Two hand-listed identical shapes = one missing derivation.
- Input = DTO class; response and internal service contract = interface; an
  entity is neither and never leaves whole.
- One representation per value set: an existing `enum`/`as const` is used by
  member, not by literal; a literal union or `as const` twin next to an enum
  is a duplicate.

## Reuse before writing new

- A package already in `package.json` before a new dependency.
- A meaningful bare number/string (timeout, limit, page size, retries, status
  code, route, storage key, header, message, regex) has a name with its unit
  (`TIMEOUT_MS`); search first — the value usually exists as a constant, enum,
  config or token. `0`, `1`, `-1`, `''` in index/empty roles are not magic.
- Used twice → one constant; a related family → `enum`/`as const` in the
  project's form.
- Existing utils, helpers, hooks before a new one — search the name and the
  verb first.
- Config only through the project's config layer: never `process.env` in
  module code, never a default that is a secret; a new variable → `.env.example`
  in the same change (name + comment, no value).

## Styles

- Only project tokens: colors, spacing, fonts, radii, shadows, z-index,
  breakpoints, transitions. A raw `px`/`hex`/`rgba`/`rem` is the signal a token
  is needed; none exists → report, don't invent.
- One styling method — the neighbours' (CSS modules, styled, utility classes);
  no inline style objects next to modules.

## Naming and shape

- The neighbour decides: suffixes (`XService`, `useX`, `XProps`, `XDto`), enum
  casing, import style, file and folder naming.
- One concept, one name (`userId` vs `ownerId`, `fetch` vs `load` = defect).
- Booleans as predicates, handlers as events — the project's form.

## KISS, SOLID, DRY

- Explicit over implicit: no hidden magic, no side effect a reader cannot see
  from the call site.
- One responsibility per module, class, component, hook.
- A copied block becomes the existing util or one new util used from both
  places; a similar component/service → parameterise the existing one. Two
  that must stay separate get a one-line reason. Merge only what changes
  together; look-alike loops with different rules stay.
- The simplest thing that meets the task; "could be more generic" with no
  second caller yet is not a reason.

## Errors and edges

- `try/catch` only with a meaningful catch; nothing swallowed or re-thrown as
  a bare string; the project's exception types.
- Null lookup, empty list, loading/error states, failed request — handled, not
  only the happy path.
