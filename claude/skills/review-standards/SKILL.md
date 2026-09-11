---
name: review-standards
description: Cross-stack TypeScript review checklist and the procedure to run it on a diff — types (no any, one representation per value set, derived not copied), constants (no magic values, existing enum/config reused), naming that matches neighbours, styles only through project tokens, duplication, error handling, leftovers. Load on the diff before every commit and whenever asked to review code, a branch, an MR or someone else's change. Finds what the linter cannot.
---

# Standards review

The project's own code is the standard. Linter, Prettier and `tsc` are run, not
re-done by hand; a finding is what they cannot see.

## Procedure

1. Read the whole diff before judging a line. Uncommitted: `git diff HEAD` +
   `git status --short`. Branch: `git diff <base>...HEAD`.
2. Verify by search, never by eye: a literal → search the value in the project;
   a new type → search its fields; a new helper → search its name and verb.
   `tokensave_search` / `rag_search` with the index, `Grep` otherwise.
   Changed signature or contract → `tokensave_callers` / `tokensave_impact`.
   Tests in the diff: do they assert behaviour or the mock? Run when in doubt.
3. Fix inside the diff silently (one line in chat per fix). Pre-existing
   problems the diff touches → one line under *Minor*, never a widening refactor.
4. Machines last: `tsc --noEmit`, linter, tests of the touched module — real
   output. Red = no commit.

Stack skill (`nestjs-backend`, `react-frontend`) structural rules apply on top.

## Checklist

**Types**
- No `any` in disguise: `as any`, `@ts-ignore`, unexplained `@ts-expect-error`,
  untyped callback param, `!` hiding a real `undefined`. `unknown` + narrowing.
- One representation per value set. Existing `enum` → use the member, not the
  string; a literal union or `as const` twin next to an enum is a duplicate.
- Derived, not copied: `Pick`/`Omit`/`extends`, `PartialType`/`PickType`,
  `ReturnType`, `z.infer`. Two hand-listed identical shapes = one missing derivation.
- Response/internal = interface; input = DTO; entity is neither.

**Constants**
- Meaningful bare number/string (timeout, limit, page size, retries, status
  code, route, storage key, header, message, regex) has a name with the unit
  (`TIMEOUT_MS`). `0`, `1`, `-1`, `''` in index/empty roles are not magic.
- Search before naming — the value usually exists (constant, enum, config, token).
- Used twice → one constant; related family → `enum`/`as const` in project form.
- Config only through the project's config layer; never `process.env` in
  module code; never a default that is a secret.

**Naming and shape**
- The neighbour decides: suffixes (`XService`, `useX`, `XProps`, `XDto`), enum
  casing, import style, file/folder naming.
- One concept, one name (`userId` vs `ownerId`, `fetch` vs `load` = defect).
- Booleans as predicates, handlers as events — the project's form.

**Duplication**
- Copied block → existing util or one new util used from both places.
- Similar component/service → parameterise the existing one. Two that must
  stay separate get a one-line reason.
- Merge only what changes together; look-alike loops with different rules stay.

**Styles**
- Only project tokens: colors, spacing, fonts, radii, shadows, z-index,
  breakpoints, transitions. Raw `px`/`hex`/`rgba`/`rem` = finding; missing
  token is reported, not invented.
- One styling method — the neighbours'. No inline style objects next to modules.

**Errors and edges**
- `try/catch` only with a meaningful catch; nothing swallowed or re-thrown as a
  bare string; project exception types.
- Null lookup, empty list, loading/error states, failed request — handled.

**Leftovers**
- No `console.log`, debug flags, commented code, ownerless `TODO`, unused
  imports/exports/params, files outside the task, unrequested lockfile/config edits.

**Not a finding:** formatting, import order, anything ESLint/Prettier own;
taste without consequence; refactor beyond the task (one *Minor* line at most);
"could be more generic" with no need yet.

## Output

Before a commit: one line per fix, then the commit.

Requested review (someone's diff, branch, MR) — spec first, then quality, ≤40
lines, ≤5 lines of quoted code:

```
Spec: ✅ | ❌ — <what is missing / extra>
Quality: approved | changes requested

Critical:  <breaks behaviour, data or a caller — path:line — why — fix>
Important: <edge-case bug, broken caller, a test that tests nothing>
Minor:     <one line each>
⚠️ Cannot verify from diff: <requirement — where to look>
```

Empty section = "нет". Never "в целом хорошо" instead of a verdict.
