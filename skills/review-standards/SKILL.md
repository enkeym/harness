---
name: review-standards
description: "Cross-stack TypeScript and Python review of a diff — broken callers, edge cases, architecture drift, types, reuse, naming, duplication, error handling, leftovers. Load on the diff before every commit and when asked to review code, a branch or an MR."
---

# Standards review

The project's own code is the standard. Its linter, its formatter and `tsc`
are run, not re-done by hand; a finding is what they cannot see.

## Procedure

1. Establish scope and evidence through [../shared/review-pass.md](../shared/review-pass.md).
   Reuse a diff or file already held in context; refresh only changed paths.
2. Match the diff against the user's task. Load applicable project and stack
   rules once. Verify literals, new types, dependency choices and test behaviour
   with scoped searches and line-range reads.
3. Reuse: search the project for the same operation, inspect the nearest
   analogue, then installed libraries. Check new blocks as well as symbols:
   query hooks, UI components, validation, formatting, error handling and
   pagination should reuse established patterns. Parameterize duplicated logic
   when useful; do not introduce a library or public API change silently.
4. Impact: check every changed behaviour through callers/impact and the
   [implicit-links map](../shared/impact-map.md). Each consumer is unaffected
   with a reason, fixed, or covered by a regression test. Add missing map links
   only when edits are authorized. No current graph → scoped rg fallback.
5. Regression: inspect history of removed or rewritten logic with
   git log -L when it may undo an earlier fix; confirm the replacement retains
   that protection.
6. Apply the checklist below to changed logic and affected callers.
7. Resolve project style through [../shared/project-facts.md](../shared/project-facts.md).
   Reuse already loaded rules; check conventions not enforced by the formatter.
8. Triage: review-only requests report without edits. In an authorized fix,
   apply certain in-scope corrections; ask only about unresolved choices,
   new dependencies, public contracts or additional scope. Recheck reuse,
   impact and style for fixes. Nothing found → no edit.
9. Run applicable project typecheck, linter and meaningful focused tests.
   Reuse successful results if relevant inputs have not changed; report what
   did not run. Failed required checks block a commit.

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

**Tests and docs**
- Changed behaviour with no test that fails on the old code → Important;
  how to write it: `test-conventions`.
- A changed command, env variable, endpoint, config key or hook behaviour →
  the README, `.env.example` or doc describing it changes in the same diff.

**Leftovers**
- No `console.log` or debug `print`, debug flags, commented code, ownerless
  `TODO`, unused imports/exports/params, files outside the task or unrequested
  lockfile/config edits outside the authorized scope (preserve them, as git-flow requires).

**Not a finding:** formatting, import order, anything the project's linter or
formatter own, unless the style file states it;
taste without consequence; refactor beyond the task (offered in step 8, never
applied unasked);
"could be more generic" with no need yet.

## Output

Before a commit: fixes and answers one line each, then `review-pass.md` step 7.

Requested review (someone's diff, branch, MR) — spec first, then quality; readable
in one pass, quoting only the lines a finding hinges on:

```
Spec: ✅ | ❌ — <what is missing / extra>
Quality: approved | changes requested

Critical:  <breaks behaviour, data or a caller — path:line — why — fix>
Important: <edge-case bug, broken caller, a test that tests nothing,
            a re-implementation of existing code — path:line — reuse <symbol/package>>
Minor:     <one line each>
⚠️ Cannot verify from diff: <requirement — where to look>
```

Empty section = "нет". Never "в целом хорошо" instead of a verdict.
