# MR review and optional delegation

Review each selected MR directly on the model chosen by the user. Never choose
a model by risk category, launch reviewers or escalate automatically. The same
rule applies to local and branch reviews. Delegation runs only when explicitly
requested by the user, using their requested model or the current model.

Pin the MR identity, source/target branches and `base_sha`, `start_sha`,
`head_sha` through [gitlab.md](gitlab.md). Reuse metadata, discussions, diff
ranges and findings already obtained at that revision.

For explicitly requested delegation, give each worker exactly one pinned MR,
`review_worker: true`, repository path, user focus, constraints, discussions,
the coordinator's single `review-lookup` result or a safe criteria summary,
necessary evidence and the required review skills. Never send the entire parent
history, the whole queue or board credentials. Workers do not read the board
again, delegate, fetch, switch branches, edit files, run tests/typecheck or
write external notes.

The worker performs full review mode in shared review-pass and returns pinned
identity, the task requirement map with evidence, findings with path/line,
read/unread coverage and unresolved questions. A missing card or access is
reported as `соответствие задаче не проверено`, never as ✅. An incomplete pass
remains incomplete; uncertainty does not trigger another model. The coordinator
reuses the result without repeating the pass.

Validate unsupported claims with only the missing range or dependency contract.
After fixes, inspect changed hunks and affected contracts, retaining valid prior
coverage. Formatting and draft delivery do not reopen the review. Before creating
authorized drafts, recheck MR diff_refs; changed revisions require fresh evidence
and do not inherit an earlier Spec ✅. Delivery follows
[gitlab.md](gitlab.md) and [report.md](report.md).
