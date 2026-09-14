# Code rules — TypeScript, both stacks

Shared by `nestjs-backend` and `react-frontend`: the stack skill adds structure
on top, `review-standards` checks the diff against this list before a commit.
The project's own code outranks any line here.

## Types

- No `any`: the exact type, or `unknown` narrowed at the boundary. Same ban on
  its disguises — `as any`, `@ts-ignore`, `!` over a real `undefined`.
- Derive, never copy: `extends`/`Pick`/`Omit`, `PartialType`/`PickType`/`OmitType`,
  `ReturnType`, `z.infer`. Two hand-listed identical shapes = one missing derivation.
- Input = DTO class; response and internal service contract = interface; an
  entity is neither and never leaves whole.
- One representation per value set: an existing `enum`/`as const` is used by
  member, not by literal; domain enumerations live once.

## Reuse before writing new

- A package already in `package.json` before a new dependency.
- Existing constants, enums, config before a new literal; a meaningful bare
  number/string gets a name with its unit (`TIMEOUT_MS`).
- Existing utils, helpers, hooks before a new one — search the name and the
  verb first.
- Global styles, CSS variables, design tokens before a raw value: never a
  hardcoded color, spacing, font, radius, z-index. Missing token → report,
  don't invent.

## KISS, SOLID, DRY

- Explicit over implicit: no hidden magic, no side effect a reader cannot see
  from the call site.
- One responsibility per module, class, component, hook; the neighbour's
  suffix and layout decide its shape.
- No duplicates: a copied block becomes the existing util or one new util used
  from both places; two look-alikes that must stay separate get a one-line reason.
- The simplest thing that meets the task; "could be more generic" with no
  second caller yet is not a reason.
