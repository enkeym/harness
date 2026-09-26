---
name: review-standards
description: "Cross-stack TypeScript review checklist and the procedure to run it on a diff — broken callers and reintroduced bugs, edge cases, deprecated or superseded constructs, drift from the project's architecture, inefficient code, types (no any, one representation per value set, derived not copied), constants and environment values, reuse of existing code and installed libraries, naming, styles through project tokens, duplication, error handling, leftovers; certain fixes applied, doubtful ones offered as a choice. Load on the diff before every commit and whenever asked to review code, a branch, an MR or someone else's change. Finds what the linter cannot."
---

# Standards review

The project's own code is the standard. Its linter, its formatter and `tsc`
are run, not re-done by hand; a finding is what they cannot see.

## Procedure

1. Read the whole diff before judging a line. Uncommitted: `git diff HEAD` +
   `git status --short`. Branch: `git diff <base>...HEAD`.
2. Verify by search, never by eye: a literal → search the value in the project;
   a new type → search its fields; a new helper, hook or component → the reuse
   order of `code-rules.md` (project, installed packages, then a library
   proposal); a new dependency → was an installed one enough.
   Tests in the diff: do they assert behaviour or the mock? Run when in doubt.
3. Impact pass on **every** symbol whose behaviour the diff changes, not only
   on changed signatures — a caller compiles fine against a function that now
   returns filtered data. `tokensave_impact` / `callers` / literal `search`, plus
   the project's [../shared/impact-map.md](../shared/impact-map.md) for links
   no call edge carries. Close each hit one of three ways: unaffected (one line
   saying why), fixed in this diff, or covered by a test that fails on the old
   behaviour. A link the map lacks → add its line in this commit. No graph
   (`.tokensave/` missing or stale) → grep the symbol name, say so in one line.
4. Regression pass: `git log -L <start>,<end>:<file>` (or `tokensave_blame`)
   on each removed or rewritten hunk. A line an earlier fix commit added, now
   gone or reverted → the old bug is back unless the diff replaces the guard.
5. Depth pass: the *Correctness and design* section below on every changed
   symbol and the code it now depends on.
6. Triage every finding:
   - Certain, one obvious fix, inside the diff, no change to a public contract
     → fix it, one line in chat.
   - Doubtful — several valid fixes, a behaviour or API change, a new
     dependency, code outside the diff, an architectural call → no edit;
     `AskUserQuestion`, one question per finding (≤4 per call), options are
     concrete fixes with the recommended first, plus leaving it as is.
   - Nothing found → no edit, one line saying the diff is clean.
7. Machines last: `tsc --noEmit`, linter, tests of the touched module — real
   output. Red = no commit.

## Checklist

Every section of [../shared/code-rules.md](../shared/code-rules.md) — read it
now unless it is already in this session's context — plus the stack skill's
structural rules and:

**Correctness and design**
- Every branch of changed logic against what its callers expect: empty,
  missing, boundary, error path, repeated call, concurrent call, order of
  awaited steps.
- Superseded construct: an API marked deprecated in the installed version's
  types or changelog, or a form the project has already moved away from (the
  newer form dominates the neighbours) → the current form. Judge by the
  installed version and the project's majority, never by a general list; a
  construct still current for both is not a finding.
- Architecture: the diff keeps the project's layers and data flow — no layer
  skipped, no second mechanism for state, data access, validation or errors
  beside the one in use, no import across a boundary the project keeps.
- Efficiency, where it scales with data or runs hot: a query or request in a
  loop, independent awaits in sequence, the same work repeated per call or
  render, an unbounded set loaded or rendered whole. Micro-gains are not
  findings.

**Leftovers**
- No `console.log`, debug flags, commented code, ownerless `TODO`, unused
  imports/exports/params, files outside the task, unrequested lockfile/config edits.

**Not a finding:** formatting, import order, anything the project's linter or
formatter own;
taste without consequence; refactor beyond the task (offered in step 6, never
applied unasked);
"could be more generic" with no need yet.

## Output

Before a commit: one line per fix and the answered questions, then the commit.

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
