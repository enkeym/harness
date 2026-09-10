---
name: review-standards
description: Cross-stack TypeScript conventions as a review checklist and the procedure to run it on a diff — types (no any, one representation per value set, derived not copied), constants (no magic numbers or meaningful string literals, repeats extracted, existing enum/config reused), naming that matches the neighbours, styles only through project tokens, duplication, error handling, leftovers. Load on the diff before every commit, and whenever asked to review code, a branch, an MR or someone else's change. Finds what the linter cannot; what the linter catches is not a finding.
---

# Standards review

The project's own code is the standard; this list is the floor beneath it. The
linter, Prettier and `tsc` are run, not re-done by hand: a finding here is
something they cannot see — a value that should have been a constant, a type
that already existed, a name that breaks the pattern of its neighbours.

## Procedure

1. **Review the diff, not your memory of it.** Uncommitted work: `git diff HEAD`
   plus `git status --short` for new files. A branch: `git diff <base>...HEAD`.
   Read the whole diff once before judging any line.
2. **Verify, don't eyeball.** Every item below has a check that is a search:
   a literal in the diff → search the value in the project; a new type → search
   its fields; a new helper → search its name and its verb. `tokensave_search`
   / `rag_search` when the index is up, `Grep` otherwise. A finding without a
   search behind it is a guess.
   For every changed signature or contract, look at the callers
   (`tokensave_callers`, `tokensave_impact`): the diff shows what changed, not
   whom it broke. Tests in the diff: do they assert behaviour or the mock? Could
   they go red? Run them when in doubt.
3. **Fix what is inside the diff; report what is outside.** Your own diff is
   fixed before the commit, silently, with one line in chat naming what changed.
   A pre-existing problem the diff merely touches is one line under *Minor* —
   never a refactor that widens the task.
4. **Last, the machines:** `tsc --noEmit`, the linter, the tests of the touched
   module — real output, not a retelling. Red means no commit.

The stack skill (`nestjs-backend`, `react-frontend`) is already loaded when the
diff touches its area; its structural rules (module layout, DI, hooks, forms)
apply on top of this list and are not repeated here.

## Checklist

### Types

- No `any` in any disguise: `as any`, `@ts-ignore`, `@ts-expect-error` without a
  reason, an untyped callback parameter, a `!` that hides a real `undefined`.
  `unknown` with narrowing where the shape is genuinely open.
- **One representation per set of values.** A domain set (statuses, roles,
  kinds, event names) lives in exactly one place. The project already has an
  `enum` for it → use the member, never the string it equals; a string-literal
  union or an `as const` twin next to an existing `enum` is a duplicate. A new
  set takes the form the project already uses for sets of that kind.
- Derived, not copied: `Pick`/`Omit`/`extends`, `PartialType`/`PickType`,
  `ReturnType`, `z.infer`, shared interfaces. Two types that list the same
  fields by hand are one type with a missing derivation.
- Response and internal shapes are interfaces; input is a DTO; an entity never
  doubles as either.

### Constants

- A bare number or string that carries meaning — timeout, limit, page size,
  retry count, status code, route, storage key, header name, error message,
  regex — has a name. The name says the unit (`TIMEOUT_MS`, `MAX_FILE_BYTES`).
  `0`, `1`, `-1`, `''` in obvious index/empty roles are not magic.
- **Search before naming.** The value usually exists already: a constant, an
  enum member, a config key, a token. Grep the literal; found → reuse it, don't
  add a second name for the same value.
- A value used twice is one constant; a family of related values is an `enum`
  or `as const` object in the project's form, not three loose constants.
- Environment and configuration only through the project's config layer
  (`ConfigService`, the client's env module), never `process.env` in module
  code, never a default that is really a secret.

### Naming and shape

- The neighbour decides. Same suffixes as the files around it (`XService`,
  `XController`, `useX`, `XProps`, `XDto`), same casing of enum members, same
  import style (path alias vs relative), same file and folder naming.
- One concept, one name. A new name for something the project already calls
  differently (`userId` vs `ownerId` for the same field, `fetch` vs `load` for
  the same action) is a defect even when each name is fine on its own.
- Booleans read as predicates, handlers as events, the way the project already
  writes them — copy the form, don't introduce a personal one.

### Duplication

- A copied block → the existing util, or one new util used from both places.
- Similar component or service → parameterise the existing one before writing
  a second. Two similar things that must stay separate get a one-line reason
  in the report.
- DRY is about meaning, not text: two loops that look alike but serve different
  rules stay separate. Merge only what would change together.

### Styles

- Only the project's tokens and variables: colors, spacing, fonts, radii,
  shadows, z-index, breakpoints, transitions. A raw `px`, `hex`, `rgba` or
  `rem` in a component or module is a finding; a missing token is reported,
  not invented.
- One styling method per project — the one the neighbours use. No inline style
  objects next to modules, no second CSS approach.

### Errors and edges

- `try/catch` only where something meaningful happens in the catch; nothing
  swallowed, nothing re-thrown as a bare string. Expected failures use the
  project's exception types.
- Boundaries are handled: null from a lookup, empty list, loading and error
  states in the UI, a failed request in a hook.

### Leftovers

- No `console.log`, debug flags, commented-out code, `TODO` without an owner or
  ticket, unused imports/exports/parameters, files outside the task, changes to
  lockfiles or configs the task did not ask for.

## Not a finding

Formatting, import order, semicolons, anything ESLint or Prettier own — run
them. Personal taste with no consequence. A refactor beyond the task — one line
under *Minor* at most. "Could be more generic" when nothing needs it yet.

## Output

Self-check before a commit: fixed, one line per fix in chat, then the commit.

A requested review of someone's diff, a branch or an MR — first whether it does
what the task asked (nothing missing, nothing extra), then quality. At most 40
lines, no code quoted beyond five lines:

```
Spec: ✅ | ❌ — <what is missing / what is extra>
Quality: approved | changes requested

Critical:  <breaks behaviour, data or a caller — path:line — why — fix>
Important: <edge-case bug, broken caller, a test that tests nothing>
Minor:     <one line each>
⚠️ Cannot verify from diff: <requirement — where to look>
```

Empty section is "нет". Never "в целом хорошо" in place of a verdict.
