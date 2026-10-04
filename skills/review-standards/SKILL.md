---
name: review-standards
description: "Cross-stack TypeScript review of a diff — broken callers, edge cases, architecture drift, types, reuse, naming, duplication, error handling, leftovers. Load on the diff before every commit and when asked to review code, a branch or an MR."
---

# Standards review

The project's own code is the standard. Its linter, its formatter and `tsc`
are run, not re-done by hand; a finding is what they cannot see.

## Procedure

1. Read the whole diff before judging a line. Uncommitted: `git diff HEAD` +
   `git status --short`, and every untracked file read whole — `git diff`
   does not show it. Branch: `git diff <base>...HEAD`.
2. Name the task (the user's request, the ticket, the commit subjects) and
   hold the diff against it: a requirement missing, a change nobody asked
   for. Load the stack skill of every touched area (`rules/core.md` Skills
   table) — its structural rules are part of the checklist.
   Verify by search, never by eye: a literal → search the value in the project;
   a new type → search its fields; a new dependency → was an installed one
   enough. Tests in the diff: do they assert behaviour or the mock? Run when
   in doubt.
3. Reuse pass on every added block, not only on new symbols — a hand-rolled
   loop inside an old function duplicates as much as a new helper does:
   - Name what the block does as a verb phrase ("format a price", "fetch a
     list with paging", "confirm before delete") and run the reuse order of
     `code-rules.md` on it: `tokensave_search` by the verb, `tokensave_similar`
     on each new symbol, `rag_search` by the phrase, then the installed
     `dependencies`.
   - Find the nearest analogue — a sibling module, page or service doing the
     same job — and compare its building blocks with the diff's: the diff uses
     the same components, hooks, helpers and library calls, not its own.
   - Hand-rolled where the project already has a tool: `fetch` + `useState`/
     `useEffect` beside a query client; raw `<button>`/`<input>`/modal/table
     markup beside a UI kit or shared component; manual date, number or
     currency formatting, deep clone, debounce, class-name joining; `if`-chain
     validation beside `zod`/`class-validator`; per-handler `try/catch`
     mapping beside an exception filter or error boundary; paging, sorting or
     query-string parsing beside a shared helper.
   - The diff copying itself: two added blocks differing only in values → one
     function or a parameterised component.
   - Hit is an exact fit → replace it in the diff. Hit needs a new parameter
     or lives outside the diff, or the fix is a new library → a doubtful
     finding for step 8.
4. Impact pass on **every** symbol whose behaviour the diff changes, not only
   on changed signatures — a caller compiles fine against a function that now
   returns filtered data. `tokensave_impact` / `callers` / literal `search`, plus
   the project's [../shared/impact-map.md](../shared/impact-map.md) for links
   no call edge carries. Close each hit one of three ways: unaffected (one line
   saying why), fixed in this diff, or covered by a test that fails on the old
   behaviour. A link the map lacks → add its line in this commit. No graph
   (`.tokensave/` missing or stale) → grep the symbol name, say so in one line.
5. Regression pass: `git log -L <start>,<end>:<file>` (or `tokensave_blame`)
   on each removed or rewritten hunk. A line an earlier fix commit added, now
   gone or reverted → the old bug is back unless the diff replaces the guard.
6. Depth pass: the *Correctness and design* section below on every changed
   symbol and the code it now depends on.
7. Project style pass, after every check above: resolve the style file (*Style
   file* row of [../shared/project-facts.md](../shared/project-facts.md)), read
   it whole and hold the diff against each of its rules in turn. It outranks
   `code-rules.md`; a rule its linter does not enforce is a finding even on
   formatting or imports. No style file → one line saying so.
8. Triage every finding:
   - Certain, one obvious fix, inside the diff, no change to a public contract
     → fix it, one line in chat.
   - Doubtful — several valid fixes, a behaviour or API change, a new
     dependency, code outside the diff, an architectural call → no edit;
     `AskUserQuestion`, one question per finding (≤4 per call), options are
     concrete fixes with the recommended first, plus leaving it as is.
   - Nothing found → no edit, one line saying the diff is clean.
   - Lines changed by a fix go through steps 3–4 and 7 again before step 9.
9. Machines last: `tsc --noEmit`, linter, tests of the touched module — real
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

**Tests and docs**
- Changed behaviour with no test that fails on the old code → Important;
  how to write it: `test-conventions`.
- A changed command, env variable, endpoint, config key or hook behaviour →
  the README, `.env.example` or doc describing it changes in the same diff.

**Leftovers**
- No `console.log`, debug flags, commented code, ownerless `TODO`, unused
  imports/exports/params, files outside the task, unrequested lockfile/config edits.

**Not a finding:** formatting, import order, anything the project's linter or
formatter own, unless the style file states it;
taste without consequence; refactor beyond the task (offered in step 8, never
applied unasked);
"could be more generic" with no need yet.

## Output

Before a commit: one line per fix and the answered questions, then the commit.

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
