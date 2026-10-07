# /review — open MRs and draft notes

GitLab API for the MR mode: list, pick, scope, drafts. Token `$GITLAB_TOKEN`
only, as `-H "PRIVATE-TOKEN: $GITLAB_TOKEN"` — never printed, never
`~/.git-credentials`. Host and project from `git remote get-url origin`, the
parse of [../../git-flow/reference/mr.md](../../git-flow/reference/mr.md)
(*Opening the MR in GitLab*): `<host>`, project id
`<group>%2F<repo>`, every `/` of the path encoded. `<api>` below =
`https://<host>/api/v4/projects/<id>`, written out in full.

## Unavailable

No token, a GitHub remote, or a list call that fails → one line why
(`MR не смотрю: <причина>`), the `Открытые MR` item is not offered; `mr`
stops there, `!<iid>` asks for its source branch.

## List and pick

```bash
curl -sS --fail-with-body -H "PRIVATE-TOKEN: $GITLAB_TOKEN" "https://<host>/api/v4/user" | jq -r .username
curl -sS --fail-with-body -H "PRIVATE-TOKEN: $GITLAB_TOKEN" "<api>/merge_requests?state=opened&order_by=updated_at&per_page=50" \
  | jq -r '.[] | [.iid, .title, .source_branch, .target_branch, .author.username, .draft] | @tsv'
```

- Drop the MRs whose author is the `/user` name before counting or listing:
  the user's own branch gets the fix menu through the `<branch>` row, never
  drafts. `!<iid>` of such an MR → its source branch through that row.
- Option label `!<iid> <title, ≤40 chars>`; description
  `<source> → <target>, <author>`, plus `черновик` when `draft`.
- None left → `Открытых MR коллег нет`, stop.
- ≤3 → one `AskUserQuestion`, `multiSelect`: `Все (<n>)`, then the MRs.
- More → the numbered list in chat, then one call: the first question
  `Все (<n>)` + 3 MRs, the next ones 4 MRs each, ≤4 questions (15 MRs); no
  question with a single option — move one MR back to it. The rest and bare
  numbers through «Other».
- `Все` picked alongside single MRs → all.

## Scope of one MR

1. `curl … "<api>/merge_requests/<iid>"` → `diff_refs` (`base_sha`,
   `start_sha`, `head_sha`), `source_branch`, `target_branch`, `web_url`.
2. `git fetch origin <source> <target>`; a fork MR (source not on origin) →
   `git fetch origin refs/merge-requests/<iid>/head`. Check
   `git rev-parse -q --verify <head_sha>^{commit}` and the same for `base_sha`.
3. Scope = `git diff <base_sha> <head_sha>` — the diff GitLab shows, so the
   line anchors land. Files as `git show <head_sha>:<path>`. Header mode
   `MR !<iid> <title>`; ticket commits do not apply.

## Drafts

All drafts of one MR in one Bash call, no question in chat first —
security-guard's confirmation is the only one. One `curl`
per finding, Minor included, in number order; body = the MR comment of
[report.md](report.md) under its rules, through a quoted heredoc into stdin:

```bash
curl -sS -o /dev/null -w '<N> %{http_code}\n' -H "PRIVATE-TOKEN: $GITLAB_TOKEN" \
  --data-urlencode 'position[position_type]=text' \
  --data-urlencode 'position[base_sha]=<base_sha>' \
  --data-urlencode 'position[start_sha]=<start_sha>' \
  --data-urlencode 'position[head_sha]=<head_sha>' \
  --data-urlencode 'position[old_path]=<old path>' \
  --data-urlencode 'position[new_path]=<path>' \
  --data-urlencode 'position[new_line]=<line>' \
  --data-urlencode note@- "<api>/merge_requests/<iid>/draft_notes" <<'NOTE_<N>'
<текст комментария>
NOTE_<N>
```

- Position only on an added line: `new_line` from a `+` row of
  `git diff -U0 <base_sha> <head_sha> -- <path>`, never counted by eye; no
  `old_line`. A removed line, a context line or one outside the hunks → no
  `position[...]` fields, the note's first line `` `<path>:<line>` `` —
  GitLab stores such a position as a draft, then «Submit review» can fail on
  it with 500.
- `400` on a positioned note → one more call for those notes, without
  position, first line `` `<path>:<line>` ``.
- Any other code (`401`, `403`, `000` …) → that note's MR comment in chat
  ([report.md](report.md)) with its code.
- After the call, `GET <api>/merge_requests/<iid>/draft_notes`: the count of
  this run's drafts matches the `201` lines, or the missing ones go to chat.
- Done → `MR !<iid>: <n> черновиков → <web_url> — проверь и нажми «Submit review»; если упадёт — не жми повторно, скажи мне`.
  Drafts stay visible only to the user until that submit.
- Submit failed → no retry and no `bulk_publish`: each attempt publishes the
  good drafts again before failing. `PUT …/draft_notes/<id>/publish` one by
  one, then `GET …/merge_requests/<iid>/discussions` — a `204` does not prove
  the note exists; a missing one → its MR comment in chat.

## Current branch with an open MR

`curl … "<api>/merge_requests?source_branch=<branch>&state=opened"`. Drafts
go there only when the reviewed code is its `diff_refs.head_sha`: the reviewed
ref is that sha, or in the uncommitted scope `git diff --quiet <head_sha>`
succeeds. Otherwise the lines would not match what the MR shows — no drafts.
