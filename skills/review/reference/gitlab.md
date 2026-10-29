# /review — open MRs and draft notes

GitLab API for MR mode: list, pick, scope, drafts. Use
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

- Drop the MRs authored by the `/user` name before counting: the user's own
  branch gets the fix menu through the `<branch>` row, never drafts; its
  `!<iid>` → its source branch through that row.
- Option label `!<iid> <title, ≤40 chars>`, description
  `<source> → <target>, <author>`, plus `черновик` when `draft`.
- None left → `Открытых MR коллег нет`, stop. Otherwise show a numbered list
  and use the requested MR or queue; ask for a selection only if it cannot
  be inferred. Use an available question tool
  only when its schema fits; do not require multiple-selection controls.

## Scope of one MR

1. GET `projects/<encoded-project>/merge_requests/<iid>` → `diff_refs` (`base_sha`,
   `start_sha`, `head_sha`), `source_branch`, `target_branch`, `web_url`.
2. `git fetch origin <source> <target>`; a fork MR (source not on origin) →
   `git fetch origin refs/merge-requests/<iid>/head`. Check
   `git rev-parse -q --verify <head_sha>^{commit}` and the same for `base_sha`.
3. Scope = `git diff <base_sha> <head_sha>` — the diff GitLab shows, so the
   line anchors land. Files as `git show <head_sha>:<path>`. Header mode
   `MR !<iid> <title>`; ticket commits do not apply.

## Drafts

Present the report before any external write. Create drafts only when the
user explicitly requested or approved their delivery; `/review` alone is
read-only. If authorization is missing, offer drafts after the report and
wait. Reuse authorization already given; native Codex approvals still apply.
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
- Done → `MR !<iid>: <n> черновиков → <web_url> — проверь и нажми «Submit review»; если упадёт — не жми повторно, скажи мне`.
  Drafts stay visible only to the user until that submit.
- Submit failed → no retry and no `bulk_publish`: each attempt publishes the
  good drafts again before failing. `PUT …/draft_notes/<id>/publish` one by
  one, then `GET …/merge_requests/<iid>/discussions` — a `204` does not prove
  the note exists; a missing one → its MR comment in chat.

## Several MRs

Review the selected queue in this session. Report each MR before moving to
the next; reuse loaded rules and preserve authorization. Use native compaction
with current MR, completed items, unread files and findings. Do not require a
new session because another task preceded review or because an MR is large.
Use handoff only when the user requests it.

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
