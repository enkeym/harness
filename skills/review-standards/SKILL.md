---
name: review-standards
description: "Cross-stack TypeScript review checklist and the procedure to run it on a diff — types (no any, one representation per value set, derived not copied), constants (no magic values, existing enum/config reused), reuse of existing code and installed libraries, naming that matches neighbours, styles only through project tokens, duplication, error handling, leftovers. Load on the diff before every commit and whenever asked to review code, a branch, an MR or someone else's change. Finds what the linter cannot."
---

# Standards review

The project's own code is the standard. Linter, Prettier and `tsc` are run, not
re-done by hand; a finding is what they cannot see.

## Procedure

1. Read the whole diff before judging a line. Uncommitted: `git diff HEAD` +
   `git status --short`. Branch: `git diff <base>...HEAD`.
2. Verify by search, never by eye: a literal → search the value in the project;
   a new type → search its fields; a new helper, hook or component → the reuse
   order of `code-rules.md` (project, installed packages, then a library
   proposal); a new dependency → was an installed one enough.
   Changed signature or contract → `tokensave_callers` / `tokensave_impact`.
   Tests in the diff: do they assert behaviour or the mock? Run when in doubt.
3. Fix inside the diff silently (one line in chat per fix). Pre-existing
   problems the diff touches → one line under *Minor*, never a widening refactor.
4. Machines last: `tsc --noEmit`, linter, tests of the touched module — real
   output. Red = no commit.

## Checklist

Every section of [../shared/code-rules.md](../shared/code-rules.md) — read it
now unless it is already in this session's context — plus the stack skill's
structural rules and:

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
