---
name: team
description: Orchestration of role agents (scout, backend-dev, frontend-dev, tester, reviewer, security-reviewer, devops) for a task spanning 3+ files or both stacks — recon, decomposition, implementation, tests, review, verification. Only when the task genuinely does not fit a direct edit: orchestration costs more than doing it yourself.
---

# /team — role orchestration

You are the controller. You don't write code by hand and you don't read whole
modules — you slice the task, hand out roles, check reports and keep your own
context clean. The design is already approved; if it isn't, do the design first.

**Threshold.** Orchestration pays off only when the roles absorb the reading and
the test runs. A two-file task you would finish yourself in a dozen turns costs
more through `/team`: dispatch, briefs, reports and review are turns on top of
the same work. If it fits a direct edit, leave the skill and say so in one line.

## 0. Branch and ledger

- Not on `main`/`dev`: `git switch -c feat/<slug>` if needed. No worktrees.
- Ledger: `.team/<YYYY-MM-DD>-<slug>.md` (the directory is self-ignored — drop a
  `.gitignore` with `*` in it on creation). First line is the task in one
  sentence; every step below appends a line. After compaction the ledger and
  `git log` are the source of truth, not your memory.
- TodoWrite: one item per subtask.

## 1. Recon — `scout`

One call, `model` taken from the role file. The prompt carries: the task in one
sentence, the stacks involved (server / client / infra), and exactly what needs
to be found out. The scout's brief goes into the ledger in full (≤40 lines);
only the brief enters your context.

If the area is already known to you and the symbols are named, skip to step 2.

## 2. Decomposition

Split by file ownership. Each subtask gets a brief file
`.team/<slug>/task-N-brief.md`:

```
# Task N: <name>
Role: backend-dev | frontend-dev | devops | tester
Files: <create / modify — exact paths>
Interfaces: consumes <…> / produces <exact names and types>
Requirements: <itemised, with exact values>
Verification: <commands and expected result>
Constraints: <from the design: versions, names, what not to touch>
Report: .team/<slug>/task-N-report.md
```

Parallelism rule: only subtasks with non-overlapping files run in parallel. A
shared file, or one producing what another consumes, means sequential. Several
small edits of the same kind share one brief instead of one agent each.

## 3. Implementation

Dispatch with `Agent(subagent_type: <role>)`; the prompt is one line of context
plus "read the brief first: `<path>`" plus the report path. Never paste the
history of previous tasks into a prompt — their interfaces belong in the brief.

Statuses: `DONE` → step 4; `DONE_WITH_CONCERNS` → read the concerns, decide, and
write the decision into the ledger as `Ruling: … — why — cost of being wrong`;
`NEEDS_CONTEXT` → supply the context and re-run; `BLOCKED` → split it, clarify
it, or raise the model (`opus`) — but don't repeat the same call.

## 4. Tests and review

- The implementer left behaviour uncovered (no tests in the report, or tests
  that assert mocks) → `tester` on the same subtask.
- Every subtask → `reviewer` with three paths: brief, report, and diff file
  (`git diff BASE..HEAD > .team/<slug>/task-N-review.diff`, BASE being the
  commit before dispatch). Constraints from the brief go into the reviewer's
  prompt verbatim.
- The task touches auth, payments, secrets, outbound calls, docker or CI →
  `security-reviewer` on the same diff as well.
- Critical/Important findings go back to the same implementer verbatim, then a
  repeat `reviewer` limited to those findings. Up to three rounds; after that
  you decide each point yourself and write a `Ruling` in the ledger. Minor
  findings are logged, not looped.
- You don't fix findings yourself: it pollutes your context and bypasses review.

## 5. Verification and finish

- Full test run, `tsc`, linter — with the real output in chat, not a retelling.
- Final message: what was done per subtask, the commits, every `Ruling` from the
  ledger as a list (this is the only place your decisions reach the human), and
  what remains (Minor findings, manual devops steps).
- Merge, push and `gh pr create` only with the human's confirmation.

## Stop conditions

You stop and ask only on: an irreversible operation; anything touching secrets
or production; leaving the branch (merge, push); or a design that turns out to
be wrong enough that any path is a guess. Everything else you decide yourself
and record as a `Ruling`.
