# /review — open MRs, merge and draft notes

GitLab API for MR mode: list, pick, scope, merge, drafts. Use
`node ~/.config/harness/repo/bin/gitlab-api.mjs --hostname <host>`;
host and encoded project: [../../git-flow/reference/mr.md](../../git-flow/reference/mr.md).
The endpoint replaces `<api>` with `projects/<encoded-project>`.
Store responses in a private temporary JSON file and check the client's exit
status before parsing with jq; do not mask failed requests in a pipe.
Paginate list endpoints when all MRs/comments are requested.

## Unavailable

An unsupported remote or a list call that fails → one line why
(`MR не смотрю: <причина>`), the `Открытые MR` item is not offered; `mr`
stops there, `!<iid>` asks for its source branch.

## List and pick

```bash
node ~/.config/harness/repo/bin/gitlab-api.mjs --hostname <host> user
node ~/.config/harness/repo/bin/gitlab-api.mjs --hostname <host> 'projects/<encoded-project>/merge_requests?state=opened&order_by=updated_at&per_page=50&page=1'
```

- An explicit `!<iid>` or URL may point to the user's own MR: review it on the
  pinned MR diff and keep the fix menu, never redirect it to the local branch.
  A generic queue lists the colleagues' MRs; do not drop an explicitly named
  own MR.
- Option label `!<iid> <title, ≤40 chars>`, description
  `<source> → <target>, <author>`, plus `черновик` when `draft`.
- None left → `Открытых MR коллег нет`, stop. Otherwise use the requested MR
  or queue; ask for a selection only if it cannot be inferred. Ask through the
  client's interactive question tool whenever it offers one — one question,
  `!<iid>` labels, `multiple` only when a queue is allowed; OpenCode calls it
  `question`. A numbered list in chat alone is not a question: it is the
  fallback only without such a tool, and then say so and accept bare numbers.
  Do not require multiple-selection controls.
- A selected queue is walked in the picked order, one MR at a time; the pass
  and reporting rules are in `SKILL.md` 1.2 and 2.

## Scope of one MR

1. GET `projects/<encoded-project>/merge_requests/<iid>` → `diff_refs` (`base_sha`,
   `start_sha`, `head_sha`), `source_branch`, `target_branch`, `web_url`, and the
   numeric `source_project_id`, `target_project_id`.
2. Require the MR's numeric `source_project_id` and `target_project_id` to equal
   the numeric `project.id` of the configured origin, resolved once through the
   client. A fork, a foreign project, a missing or non-numeric id, or an
   unresolved origin project skips `review-lookup`: report `соответствие задаче
   не проверено` with that reason and continue the standard code review. Never
   guess a link.
3. From the confirmed `source_branch`, run exactly one read-only
   `review-lookup --branch <source_branch>` before fetch, discussions, diff or
   pass. The key comes only from that branch, never the title or local `HEAD`.
   Missing configuration, no/several keys, no/several cards or lost access →
   continue the code review and report `соответствие задаче не проверено` with
   that reason; no Spec ✅ and no board write.
4. `git fetch origin <source> <target>`; a fork MR (source not on origin) →
   `git fetch origin refs/merge-requests/<iid>/head`. Check
   `git rev-parse -q --verify <head_sha>^{commit}` and the same for `base_sha`.
5. Scope = `git diff <base_sha> <head_sha>` — the diff GitLab shows, so the
   line anchors land. Files as `git show <head_sha>:<path>`. Header mode
   `MR !<iid> <title>`; ticket commits do not apply.

## Merge a clean MR

A merge is offered only after a complete pass with no findings at any severity,
a confirmed task-level ✅ when a card applies, no unresolved resolvable
discussion and no uncovered required manual check. Findings, `changes
requested`, `соответствие задаче не проверено`, a partial batch, an unread file,
a stale approval or CI state, or any unknown field → no merge; report the
reason and stop.

Selecting the MR in `mr` mode, including a queue pick, is not authorization.
After the full report, ask through the client's interactive question tool:
`Merge` (Recommended) and `Оставить без действий`. An explicit «merge !<iid>»
for that exact MR is also authorization. Reuse permission only for the same
pinned MR; a queue binds each MR and its consent separately. Never merge
because findings were approved, drafts were authorized, or the review is clean.

1. The authoritative MR URL, the pinned card `id` and the requirement
   fingerprints come from the completed pass; do not run another
   `review-lookup`. `review-merge` itself re-reads one fresh board snapshot
   immediately before the irreversible write and requires the same single key,
   the same card `id`, and the same `name`/`desc` SHA-256. A changed
   requirement, replaced card or reassigned key invalidates the task-first ✅
   and blocks the merge; no task data goes into chat, the MR or a draft. Do not
   skip this because the code diff did not change: the card can be edited after
   the pass.
2. Run exactly one
   `node <gantus-base>/scripts/gantus.mjs review-merge` with `--mr-url` (the
   reviewed MR URL), `--project-id` (the origin `project.id` pinned with the
   metadata), `--key`, the pinned `--card-id`, `--source-branch`,
   `--target-branch`, `--base-sha`, `--start-sha`, `--head-sha`,
   `--name-sha256`, `--desc-sha256` and `--gitlab-user-id`. The command is the
   only merge actor. It re-proves the card id and fingerprints, the edit ACL and
   the review→testing route, and after every discussion page has been read it
   repeats that same route, key and fingerprint check on one fresh snapshot
   before the final MR read and PUT; it pins the source and testing target ids
   from that internal route, not from a parameter. Before that final MR read and
   PUT it also performs a runtime `GET /user` and requires a valid `id` equal to
   `--gitlab-user-id`; a missing, invalid or mismatched identity blocks with no
   PUT. It reads every discussion
   page (`.../discussions?per_page=100&page=<n>`, bounded at 50 pages):
   an open resolvable thread blocks. Standalone non-resolvable notes are not
   unresolved threads; the reviewer already reads them, and an actionable
   comment blocks the clean verdict in the report. A malformed note or
   discussion — including an empty `notes` array or a missing/contradictory
   `resolvable`/`resolved` flag — is never treated as complete and blocks.
   It then takes a fresh `GET .../merge_requests/<iid>` requiring equal numeric
   project/source/target ids (no fork) equal to `--project-id`, `state:"opened"`,
   `draft:false`, `source_branch`/`target_branch` as pinned,
   `detailed_merge_status:"mergeable"`,
   `blocking_discussions_resolved:true`, `has_conflicts:false`,
   `force_remove_source_branch:false`, and every present source-head field
   (`diff_refs.head_sha` and `sha`) equal to the reviewed value; a stale or
   mismatched one blocks even when the other matches. Do not infer resolved
   discussions from `blocking_discussions_resolved` alone. Required approvals
   and pipelines are covered by `mergeable`; any other status blocks. Never
   approve or request changes to make it mergeable.
3. The command sends one `PUT .../merge_requests/<iid>/merge` with exactly
   `{"sha":"<reviewed head_sha>","should_remove_source_branch":false}` through
   the strict single-attempt transport. Never add `auto_merge`,
   `merge_when_pipeline_succeeds`, `squash`, `force_remove_source_branch`,
   labels or a branch deletion, and never repeat the write yourself. `sha` is a
   compare-and-swap for the source HEAD only, not for `target_branch` or its
   base; a concurrent target move is not excluded, so the fresh GET and the
   response check are mandatory. GitLab server guards remain final; this is not
   a cross-service CAS.
4. Outcome handling is owned by the command: `400`, `401`, `403`, `405`, `409`
   or `422` → no merge and no board move. `409` is a definite rejection; its
   cause is not asserted without a parsed response — it may be a changed source
   SHA or a concurrent merge.
   A 2xx body is accepted only when it proves the same `iid`, project ids,
   branches, reviewed source head, `state:"merged"`, `draft:false`, a parseable
   `merged_at` and, when present, the same merger; a 2xx with an incomplete or
   malformed receipt is replaced by one authoritative GET of the same `iid`,
   and only a merge proven that way proceeds to the guarded board move.
   A genuinely ambiguous transport — timeout, network failure or `5xx` — is
   never replayed: at most one read-only GET of the same `iid` may prove the
   merge, and a proven merge then returns `merged:true` with
   `testMove:{moved:false,reason:"ambiguous-merge"}` and **zero board writes**;
   recovery needs a new explicit consent. If that GET does not prove the merge,
   report the GitLab outcome as unconfirmed and check it only through the
   separate read-only `post-merge`; never re-run `review-merge` or send a second PUT.
   A fast-forward or squash merge keeps the source head, so
   `merge_commit_sha` is not required.
5. The merge scope is only a linked clean MR whose pinned lookup produced the
   task ✅ for this same MR and project. A missing card, another project, a
   contradictory card or absent configuration → stay read-only and report the
   merge as not attempted; never fall back to a receipt, local `HEAD`, a title
   or a plain-MR merge.
6. Only after a confirmed merge does `review-merge` consider the exact pinned
   card for review→testing (or report `already`/`column-changed` without a
   write), re-checking on a fresh snapshot the same key/id, requirements,
   source and target ids and ACL pinned before the PUT. Load `gantus` by exact
   id first if it is not loaded. The result always reports `merged:true`
   separately from `testMove`: a board PATCH, ACL, route or read-back error
   becomes `testMove:{moved:false,reason:"failed"|"unconfirmed"}` with no
   secrets, never invalidates the confirmed merge and never triggers a second
   merge. Recovery is a separate action that requires fresh explicit consent
   and is never automatic. The read-only `post-merge` re-verifies the merged MR
   by `iid` and reports the actual card column and status; it sends no PATCH
   and does not move the card. When the earlier run left the card unmoved, the
   recovery is: read-only `post-merge`, then fresh explicit consent, then
   `move-to-testing` with the same saved pins (`--mr-url`, `--project-id`,
   source/target, `--expected-sha`, `--gitlab-user-id`, `--key`, `--card-id`,
   `--name-sha256`, `--desc-sha256`; full syntax in
   `../../gantus/reference/workflow.md`). If those pins were lost, do not guess
   them. `move-to-testing` moves only a merged MR proven to be merged by the
   same authenticated GitLab user.
7. A clean path has no comments and no drafts: do not create a positive,
   summary, approval or "merged" note and do not call any `draft_notes`
   endpoint. The report in chat and the merge menu are the whole output.
   Findings keep the draft-only delivery below, unchanged.

## Drafts

Present the report before any external write. Create drafts only when the
user explicitly requested or approved their delivery; `/review` alone is
read-only. If authorization is missing, offer drafts after the report and
wait. Reuse authorization already given.

Delivery always means private draft notes. «Отправь», «отправь в MR»,
«размести», «оставь комментарии», «да» after a draft offer, or approval of
findings never authorize publication. This restriction applies to the
coordinator, workers and follow-up requests, even an explicit request to
publish: leave drafts and tell the user to submit manually in GitLab.
Never call `draft_notes/bulk_publish`, `draft_notes/<id>/publish`, create
public notes/discussions, submit/approve/request changes through API or CLI,
or click «Submit review»/«Publish» in a browser. No publication fallback,
retry or alternate tool is allowed. Chat verdicts remain report text only.

One request per finding, in number order; body = the MR comment of
[report.md](report.md). Write a JSON body file with `note` and, where valid,
a `position` object containing position_type, base_sha, start_sha, head_sha,
old_path, new_path and new_line. Keep actual newlines in JSON strings.

```bash
node ~/.config/harness/repo/bin/gitlab-api.mjs --hostname <host> --method POST --input <note.json> projects/<encoded-project>/merge_requests/<iid>/draft_notes
```

- Position only on an added line: `new_line` from a `+` row of
  `git diff -U0 <base_sha> <head_sha> -- <path>`, never counted by eye; no
  `old_line`. Any other line → no `position[...]` fields, first line
  `` `<path>:<line>` `` — GitLab stores such a draft, then «Submit review»
  fails on it with 500.
- `400` on a positioned note → resend those without position, same first line.
- Any other code (`401`, `403`, `000` …) → that note's MR comment in chat
  with its code.
- Then `GET <api>/merge_requests/<iid>/draft_notes`: this run's drafts match
  the `201` lines, or the missing ones go to chat.
- Done → `MR !<iid>: <n> черновиков → <web_url>. Не опубликованы; проверь и отправь ревью вручную в GitLab`.
  Drafts stay visible only to the user until their manual submit.
- Submit failed → read-only inspection of drafts and discussions; report
  confirmed published, remaining and uncertain notes in chat. Never publish,
  retry submit or recreate possibly published notes. Leave remaining drafts
  untouched; the user resolves submission manually in GitLab.

## Several MRs

The main session coordinates the selected queue; each MR gets a fresh subagent
under [mr-delegation.md](mr-delegation.md), including a single selected MR.
Prepare fetches and pinned scopes before dispatch; workers do not fetch or
switch branches. Report each completed MR separately, preserving authorization.
Use native compaction with pinned scopes, worker IDs, completed items, unread
files and findings. Do not reuse a worker for another MR or require a new user
session because an MR is large. Use handoff only when the user requests it.

## Existing comments

GET `projects/<encoded-project>/merge_requests/<iid>/discussions?per_page=100&page=1`.
Parse only a successful response; paginate before claiming no existing comments.

- A finding an open comment already names → no finding, no draft; the summary
  counts it.
- An open comment on a line the reviewed code changed since → fixed or still
  there, one line each in the summary.
- Nothing open, or the call fails → one line, the pass goes on.

## Current branch with an open MR

GET `projects/<encoded-project>/merge_requests?source_branch=<encoded-branch>&state=opened`. Drafts
only when the reviewed code is its `diff_refs.head_sha` — the reviewed ref is
that sha, or in the uncommitted scope `git diff --quiet <head_sha>` succeeds;
otherwise the anchors miss the MR's lines.
