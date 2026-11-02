# MR coordinator and workers

MR mode authorizes one fresh subagent per selected MR, subject to the current
client's tools and user permissions. The main session coordinates selection,
scope preparation, risk routing, escalation and reports. Never delegate the
whole queue to one worker. Non-MR review keeps its existing workflow.

## Prepare and classify

For each selected MR, obtain metadata, fetch and verify the scope through
[gitlab.md](gitlab.md). Pin project, IID, URL, source/target branches and
`base_sha`, `start_sha`, `head_sha`. Read its file inventory, relevant diff
hunks and existing discussions before choosing a model; a title, extension or
diff size alone is insufficient. Classification is preliminary, not the pass.
Stop classification once evidence requires Pro; do not read the whole diff
to prepare a worker that will review it again. Pass already obtained evidence
with its revision and path/range so the worker can reuse it.

Use Flash only when all of these are established:

- Changes are local and affected callers/consumers are identifiable.
- No security boundary, authorization, sensitive data handling, schema,
  migration, destructive operation or external/persisted contract changes.
- No complex state transition, concurrency, transaction, retry, cache,
  background work or cross-service behavior needs reasoning.
- Expected behavior and compatibility can be checked directly from evidence.
- No material dependency or behavior remains unknown at classification time.

Otherwise choose Pro. Examples: ordinary prose, a local presentation adjustment
or a mechanical rename with verified consumers may qualify for Flash. Access
control, API/socket/storage contracts, migrations, races and uncertain impact
require Pro. Documentation containing executable commands or security guidance
is assessed by its effect, not its extension. Use no line/file-count threshold
or additive score that can offset a high-risk condition.

Report `MR !<iid> — Flash|Pro: <evidence-based reason>` before dispatch.
Resolve role-to-model mappings from the active client configuration. In the
DeepSeek OpenCode integration, use `harness-review-flash` for Flash and
`harness-review` for Pro. Do not switch the main session's model for this.
Other clients use their supported native subagent/model controls; never invent
model IDs. If model selection is unavailable, state the actual model and
limitation and use the available worker model; do not claim Flash/Pro routing.
If delegation is unavailable or forbidden, state why and mark affected MRs
not reviewed rather than silently reviewing the queue in the coordinator.

## Dispatch

Use fresh isolated worker contexts with only the task, accepted constraints and
necessary evidence, never the parent's conversation. Bound simultaneous workers
by the client's available slots and queue the rest; one slot means sequential
fresh workers. Fetch/ref mutations belong to the coordinator, not workers.

Each task includes:

- `review_worker: true`, repository path and pinned MR identity/SHAs.
- User focus, selected role and routing reason; existing discussions or their
  verified retrieval status and authorization relevant to read-only review.
- Instructions to read project rules, the review skill, review-standards,
  review-security, shared review-pass and affected stack skills.
- Scope `git diff <base_sha> <head_sha>`; file and caller reads at `head_sha`.
  The working-tree graph is usable only if it matches that SHA and is current.
- No delegation, checkout, fetch, code/file edits, tests/typecheck or external
  writes; list unavailable checks. The coordinator alone handles API response
  temporary files and any explicitly authorized drafts through gitlab.md.

Both roles perform the same mandatory review pass and coverage accounting;
Flash never means a shorter checklist. A worker returns pinned identity,
actual model when exposed, `complete` or `needs_pro`, actionable findings with
path/line, evidence and manual reproduction, read/unread files, unverified
questions and existing-comment disposition. An incomplete pass cannot be
reported as a clean review.

For each finding, return the exact revision/path/line, a short code excerpt,
the triggering condition, consequence and proposed fix. Cite the caller or
dependency contract when the claim depends on it; distinguish verified facts
from assumptions. Include the report fields required by report.md so the
coordinator can format the result without reconstructing the pass.

Reuse unchanged source ranges still in context. Read a missing range or
specific caller for a named unresolved question; do not reread whole files
to regain orientation. After compaction, restore the pinned scope, coverage
and outstanding questions first; reread only missing evidence. Neither a
repeat nor a context compaction starts the review inventory over.

## Escalate and report

A Flash worker discovering a risky contract, hidden dependency, ambiguous
invariant or uncertainty it cannot resolve returns `needs_pro` with concrete
evidence, findings so far and outstanding coverage. It does not create another
agent. The coordinator starts a fresh Pro worker for the same pinned MR,
passing this evidence; Pro completes the full pass and validates inherited
findings. Do not loop through Flash again. If Pro is unavailable, report the
review as incomplete with the reason, not as passed.

The coordinator checks pinned identity, coverage and the evidence for each
finding, deduplicates against existing discussions and reports each MR using
[report.md](report.md). The worker owns the full pass; do not run another pass
in the coordinator, either while waiting or after receiving the result.

Validate a finding from its supplied evidence and any source already held.
If a claim remains unsupported, name the missing fact and inspect only its
relevant range or dependency contract. For example, a library resource leak
claim requires its removal/destruction contract, not just a missing explicit
destroy call. Do not publish an unverified assumption as a finding.
For incomplete coverage or unresolved review questions, request the missing
evidence from the same worker when supported; otherwise report the gap.
Use a fresh Pro worker only for the escalation above or a changed MR scope,
not to repeat a complete review. Stop source exploration once findings and
coverage are supported; formatting and draft delivery do not reopen the pass.
Preserve coverage and not-checked limitations. Workers never create draft notes.
Before creating authorized drafts, re-read the MR's diff_refs; any changed
scope makes the result stale. Obtain a new pinned scope and fresh review before
anchoring drafts. Never silently reuse findings against a newer branch head.
