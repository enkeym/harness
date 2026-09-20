# Memory hygiene — what memory may answer

Read by `task-brief`, `review-standards` and `test-coverage` before trusting a
recalled fact, and by any session about to write one. `tokensave-routing`
decides which memory tool to call; this file decides what may go in and what a
recalled line is allowed to settle.

Memory is loaded into the window before the first turn. A number sitting there
reads as an established fact, so a recalled measurement silently replaces the
run that would have produced it — the failure this file prevents.

## Method in, measurement out

- **Write**: how to reproduce a check (the exact command), why an option was
  chosen, what was rejected and on what evidence, a constraint the code cannot
  state.
- **Never write**: run results, benchmark numbers, coverage or pass/fail
  status, "the discrepancy is closed", "the suite is green". Those belong in
  the project's own docs next to what they describe, where they read as a
  dated document rather than as context.
- A measurement worth keeping anyway (a baseline the next session must beat)
  carries `validFor: <commit sha>` in its frontmatter and the word
  `непроверено` in its first line.

## Recall does not count as verification

- A recalled number, status or "works / is correct" claim is a **hypothesis**.
  Re-run the command before it reaches the user, or say which line it came
  from and that it was not re-checked.
- `validFor` present and `git rev-parse HEAD` differs → the line is stale by
  definition; re-run or drop it, never quote it.
- The words "всё сходится", "корректно", "в порядке", "зелёные" require a
  command executed **in this session**. No such command → write "не проверял"
  and name what would settle it.
- A bug the user reports outranks every recalled line that says otherwise.
  Build the hypothesis from the code, not from memory; a memory line that
  contradicts the report is the first suspect, not the answer.

## Keeping it fresh

- A memory naming a file, symbol, flag or command: confirm it exists before
  recommending it. Gone → fix the line or delete it in the same turn.
- Deleted a module, script or flag → grep memory and the impact map for its
  name in the same commit; a line whose subject no longer exists is deleted,
  not annotated as removed. A tombstone costs context every session.
- Superseded decision → rewrite that memory in place. Two memories on one
  question disagree within a month, and the stale one gets read.
- Wrong once → delete it. A memory that misled the user has no second chance.

## Audit

Run when memory has grown past a dozen entries, when the user reports an
answer that came from memory and was wrong, or before a long task in a project
not touched for weeks:

1. List entries; for each, name its type — method, decision, or measurement.
2. Measurement without `validFor` → move the numbers to the project's docs,
   keep only the command that reproduces them.
3. `validFor` older than the current HEAD → re-run or delete.
4. Names in the body that no longer resolve → fix or delete the entry.
5. Report as `<entry> — <kept | rewritten | deleted> — <why>`, one line each.
