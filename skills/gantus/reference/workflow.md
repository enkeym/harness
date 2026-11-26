# Gantus workflow reference

Optional integration for one configured board. Load only for an explicit user
request (including branch/card creation for completed local changes) or the
post-MR sync/legacy review step. Everything is local: no live Gantus run is
part of the test suite.

## Configuration

Values come from the process environment. Add only the named `GANTUS_*`
assignments below through the environment setup you already use — append them
to `~/.config/harness/env` or export them in the shell — without replacing that
shared file or overwriting unrelated variables. `../.env.example` lists the
names with empty values as a template; it is not sourced. Never commit a real
cookie. The CLI reads the process environment and never the file itself.

| Variable | Meaning |
|---|---|
| `GANTUS_BASE_URL` | Closed Gantus origin. HTTPS, or plain HTTP for `localhost`, `127.0.0.1` or `[::1]`, or one literal RFC1918 IPv4 origin exactly matched by `GANTUS_ALLOW_HTTP_ORIGIN`. No path, query, fragment or credentials. |
| `GANTUS_ALLOW_HTTP_ORIGIN` | Optional exact HTTP origin — scheme, literal RFC1918 IPv4 and exact port — for that one private host. Not a global HTTP bypass: another host, port, public address or hostname stays rejected. Use only on a trusted network segment; the session cookie and writes are sent without TLS. |
| `GANTUS_TEAM_ID` | Exact id of the single configured board. |
| `GANTUS_SESSION_COOKIE` | Owner-provided authorized session cookie, one `name=value` pair. Never captured from a browser and never replaced by a Bearer key. On 401 ask the owner to refresh it. |
| `GANTUS_USER_ID` | Expected numeric `/api/auth/me.id`; a different account stops before board data. |
| `GANTUS_GIT_REMOTE` | Exact `git remote get-url origin` for this repository. Required by `sync`, `review-lookup`, `review-ready` and `rename-branch`; another project cannot feed its STR into them. |
| `GANTUS_REVIEW_COLUMN_ID` | Optional exact id of the one review column on the configured board. Set together with the source list; absent means `sync` updates text and QA but skips the move. |
| `GANTUS_REVIEW_FROM_COLUMN_IDS` | Comma-separated unique ids of the source columns from which `sync` may move a card. Required when the review column is set. A later column is not rolled back. |
| `GANTUS_TESTING_COLUMN_ID` | Optional exact id of the one testing column for `review-merge`; absent falls back to the single board column whose observed status is `testing`. The source is always the review column, so no separate source list exists. `post-merge` only reads the board and reports the actual card column. |

Validation happens before any request. Missing or invalid values exit 2 and
send nothing. HTTP redirects are not followed, proxies are disabled, and the
cookie travels only in the request header. The HTTP opt-in permits that exact
origin but never encrypts traffic, so trust the whole network path.

## Board column ids

Ids of the configured board (827, «Веб Гроза»), read from
`GET /api/kanban/boards/:teamId`:

| id  | name             | status     |
| --- | ---------------- | ---------- |
| 142 | К выполнению     | todo       |
| 147 | На паузе         | paused     |
| 146 | Заблокировано    | blocked    |
| 272 | Ошибки           | paused     |
| 143 | В работе         | inprogress |
| 144 | На ревью         | review     |
| 145 | Тестирование     | testing    |
| 148 | Готово к релизу  | done       |
| 271 | Обновлено        | done       |

`sync` targets the review column 144 from the source columns 142 and 143;
`review-merge` merges the reviewed MR and then moves 144 → 145, while
`post-merge` only reconciles that move by reading GitLab and the board. If the
board is changed, take the new ids from a board read and update this table and
the environment together. A local fixture may report the testing column with a
`null` status, so tests and a board without the machine status use the explicit
ids; neither the table nor a fixture proves live placement.

## Commands

Run `node <base>/scripts/gantus.mjs` with one of these commands from the target
repository; `<base>` is the resolved `gantus` skill directory and the working
directory stays the repository under work:

```
get --key STR-12
preflight [--key STR-12]
review-lookup --branch feature/STR-12
create --name TEXT --desc TEXT --start YYYY-MM-DD --end YYYY-MM-DD --priority P0|P1|P2|P3
start --key STR-12
edit --key STR-12 [--name TEXT] [--desc TEXT] [--priority P0|P1|P2|P3]
comment --key STR-12 --body TEXT
move --key STR-12 (--column COLUMN_ID | --to review)
sync --key STR-12 --mr RECEIPT_FILE_OR_JSON --desc TEXT --qa TEXT --gitlab-user-id ID --expected-desc TEXT --expected-card-id ID [--expected-mr-desc TEXT] [--replaced-desc TEXT]
review-merge --mr-url URL --project-id PROJECT_ID --key STR-12 --card-id ID --source-branch BRANCH --target-branch BRANCH --base-sha SHA --start-sha SHA --head-sha SHA --name-sha256 SHA256 --desc-sha256 SHA256 --gitlab-user-id ID
post-merge --mr-url URL --project-id PROJECT_ID --key STR-12 --card-id ID --source-branch BRANCH --expected-target-branch BRANCH --expected-sha SHA --gitlab-user-id ID
review-ready --key STR-12 --mr RECEIPT_FILE_OR_JSON
rename-branch --key STR-12 --branch EXACT_BRANCH_NAME
```

Text values that start with `---`, `--` or trailing spaces use `--flag=value`
or the matching `--flag-file <path>`; both preserve the bytes exactly. A file
is read once, must be a regular file no larger than 1 MiB, and cannot be
combined with the direct flag.

Success prints one JSON object without raw API responses, bootstrap data,
personal data or error bodies. Errors go to stderr with a non-zero status.

## Wire contract and lookup

1. `GET /api/auth/me` → compare `id` with `GANTUS_USER_ID`; keep `employeeId`
   and `role` only in memory.
2. `GET /api/kanban/boards/:teamId` → `{board, columns, cards}`. `board` has
   `id`, `deptId`, `teamId`, `teamName`; `columns` has `boardId`, `id`,
   `status`; `cards` has `id`, `columnId`, `order`.
3. `GET /api/data/bootstrap` → `departments` and `tasks`. Join `card.id` with
   `task.id`, then require the board's `deptId` and `teamName`. The key is
   `task.taskKey`, otherwise `${department.tag}-${task.taskNumber}` from the
   department whose `id` is `task.dept`.
4. Match the requested key exactly. A missing key or several matches on the
   configured board block every write. Cards without a joined task stay only
   for target-column ordering and never match a key.
5. `GET /api/data/tasks/:id/comments` → a bare array. Each comment has a string
   `body` and an optional numeric or string `authorId`; `empId` is not the
   authenticated identity. A malformed payload blocks before any write. The QA
   dedupe compares that exact body and `authorId` with `/api/auth/me.id`.

The board endpoint and the bootstrap join are read as one snapshot
immediately before a write. Every guard and the request body are derived from
that snapshot; no earlier board read is reused.

## Create

One `POST /api/data/tasks` with `Content-Type: application/json` and exactly:

```
name, desc, dept = board.deptId, team = board.teamName, planned: true,
status: "todo", priority: P0..P3, start, end, category: "task",
assignee = identity.employeeId
```

`desc` and both dates are explicit non-empty input; no dates are invented. The
assignee is always the authenticated account: `employeeId` comes from
`/api/auth/me`, whose `id` was already checked against `GANTUS_USER_ID`. A
missing `employeeId` blocks the create instead of leaving the task unassigned.
The POST is the only write: it sends no card or column id and makes no follow-up
card PATCH. A 2xx response must contain a safe `taskKey` and `id`. A 2xx without
them, a 5xx or a timeout is an ambiguous write: report it, never repeat the
POST. `status:"todo"` is the task field observed in this contract; the live
board's physical placement of a newly created card in column 142 is not proven
by the request or by a fixture, so do not promise it without a live read.

## Start

`start --key STR-12` is the explicit transition from todo to work. One board
snapshot resolves the exact card and its edit ACL, the single column whose
machine status is `todo` and the single column whose status is `inprogress`;
zero or several status columns block before any write, as does a missing card.
`editProtected`, creator and assignee rules are the normal edit guard; no new
permission is invented. A card already in the inprogress column is
`{moved:false,reason:"already"}` with no write. A card in review, testing, done,
paused, blocked or any other column is `source-not-allowed` and is never rolled
back. Only a card in the todo column is PATCHed once with the target column id
and the full target order; the successful response is
`{moved:true,taskKey,fromColumnId,columnId}`. A branch-only card stays in todo
until this command is explicitly requested.

## Edit and comment

`edit` sends one `PATCH /api/data/tasks/:id` containing only the explicitly
requested fields from `name`, `desc`, `priority`. It never sends status,
assignee, dates or category. `editProtected` is enforced: admin, the task
creator or the assignee may write; an open task is not restricted beyond that.

`comment` sends one `POST /api/data/tasks/:id/comments` with `{body}`. It is
allowed only when the task passes the same edit guard and the department's
`teamComments[task.team]` is true. Attachments are out of scope.

## Move

`PATCH /api/kanban/cards/:id` with `{columnId, orderedIds}`. One snapshot read
provides the card, its ACL, the target column and the full target order; the
same snapshot forms the request. The target must be a column of the configured
board. `--to review` requires exactly one column with machine status `review`;
zero or several block the move. `orderedIds` contains the target column's ids
in `order` ascending with numeric id tie-break, current card excluded, then the
moving card once at the end. If the card is already in the target column,
nothing is written. No source-column reorder is sent and a card from another
board is never moved.

## Preflight and applicability

`preflight` is read-only and runs before any GitLab or Gantus write. It derives
the exact single strict key from the current named branch when `--key` is
omitted; a supplied `--key` is only an equality check and is never invented. It
never sends board credentials before applicability is known and never moves or
edits anything. Its JSON distinguishes:

- `{configured:false}` — none of `GANTUS_BASE_URL`, `GANTUS_TEAM_ID`,
  `GANTUS_SESSION_COOKIE` or `GANTUS_USER_ID` is set. `GANTUS_GIT_REMOTE`
  alone does not activate the integration. A plain MR continues without
  Gantus.
- exit 2 with a `config` error — the integration is invalid or incomplete for
  the current repository: a partial base configuration or an invalid value.
  This is an active configuration error, not absence.
- `{configured:true, applicable:false, reason}` — the base configuration is
  valid but this request is outside its scope: `remote-not-configured` or
  `remote-mismatch`. No board request is made, and the output never echoes
  either remote value, because a URL can contain credentials.
- `{configured:true, applicable:true, ready:false, reason:"no-key",
  needsLink:true, branch}` — the current `origin` matches the configured remote
  but the named branch has no strict key. This is an explicit link gate, not a
  plain-MR pass: run the scoped branch-only workflow (reuse or create one linked
  card, name the branch `<prefix>/<key>`) and repeat preflight, or ask one
  targeted question and stop. Preflight itself makes no board request.
- `{configured:true, applicable:true, ready:true, taskKey, card, review}` —
  the current `origin` equals `GANTUS_GIT_REMOTE`, the branch has exactly one
  strict key, one card exists and is assigned to the current employee, comments
  are enabled, and a configured review target exists.

A plain MR in another repository with a globally configured
`GANTUS_GIT_REMOTE` treats `applicable:false` as “Gantus does not apply here”
and continues ordinary GitLab delivery without a board call. An explicit
Gantus request treats any `configured:false`, `applicable:false` or non-zero
exit as a blocker; it never degrades into a plain publication. A matching
remote with a fatal known reason — several keys or cards, a mismatched key, a
foreign current assignee, disabled team comments or an unknown configured
review target — also blocks before the MR write. A card already in a later
column is not fatal; preflight reports the skip reason.

The branch key is authoritative and strict, never a title substring. A supplied
`--key` must equal it; a keyless branch with `--key` is a mismatch, not a board
lookup. A former creator is not sufficient: the current `assignee` must equal
the authenticated `employeeId` before publication, and again before any later
write.

## Review lookup

`review-lookup --branch <source_branch>` is the one read-only board read for an
explicitly selected MR. Run it after that MR's authoritative metadata pins the
confirmed `source_branch`, before `git fetch`, discussions, diff or the review
pass. It reuses the configured origin, `/api/auth/me` identity, bootstrap board
and strict branch key. It does not require the local branch, current assignee,
team comments or a review column, and it never writes.

The key comes only from the confirmed source branch, never from the MR title or
local `HEAD`. `no-key`, `several-keys`, `no-card` and `several-cards` are
reported separately. `configured:false`, `remote-not-configured`,
`remote-mismatch`, a configuration error or a failed identity check sends no
board request. A missing card or access leaves the code review valid but
reports `соответствие задаче не проверено`; it never becomes a task-level ✅.
An ordinary review without a selected MR does not call this command.

## Sync description, QA and review

`sync` is the single post-MR reconciliation for an explicit publish request. It
runs only after the caller's own confirmed GitLab create or update POST/PUT,
local review and required checks. The caller reads the card first, composes one
safe final body with mandatory requirements, confirmed extras and preserved
manual context, and uses that exact body for the MR and `--desc`. A missing
mandatory result blocks publication; review fixes are rechecked against the
final diff; an independent fix stays out. No secrets, personal data or review
notes are copied.

Receipt: reuse the MR write response; add `operation: "create" | "update"`,
`author.id` and `description`. Pass the current GitLab user id from the existing
client's `user` result as `--gitlab-user-id`, and the card `desc` read before
publication as `--expected-desc`. For an update also pass the existing MR
description read before the PUT as `--expected-mr-desc`. `sync` validates at
the boundary, before any write:

- open, non-draft MR, operation create/update, and `author.id` (numeric or
  numeric string) equals the current GitLab user; a Draft or a foreign author
  stops the flow;
- exactly one existing MR for the branch was read: no fork/source-target
  ambiguity, and `source_branch` equals the current branch and has exactly one
  strict key equal to `--key`;
- `web_url` matches the project and `iid` from `GANTUS_GIT_REMOTE`;
- `description` equals `--desc`;
- the card belongs to the current account, its current `assignee` equals the
  authenticated employee, comments are enabled, and the local project remote
  matches.

A failed check sends no write. The final body must retain every distinct
manual block from both the card read (`--expected-desc`) and the existing MR
read (`--expected-mr-desc`); blocks shared by both are the generated portion
and appear once. A missing manual block, a repeated block or a conflicting
body blocks the write instead of replacing the latest manual edit. For a
create there is no existing MR side and the card remains the source. An absent
description compares as empty. Equal values are a no-op: no PATCH, comment or
move. This is not a compare-and-swap guarantee; a concurrent edit between the
read and write is still possible.

QA is one readable comment:

```
Проверка MR !<iid> (<source_branch>)

<qa>
```

`<qa>` states the changed behaviour, steps and expected result; it never claims
a manual run that did not happen and never copies task or foreign review text.
Before posting, `sync` reads the task comments resource. It reuses a comment
only when the author is the current account and the body exactly matches the
same MR, branch and QA apart from terminal line endings; internal blank lines,
spaces and other text stay significant. A missing or invalid author is ambiguous
and blocks; an exact body from another author is a conflict and is never reused.
A changed QA adds one new comment.

No documented machine status selects the target. It is the exact
`GANTUS_REVIEW_COLUMN_ID` (144 on the current board);
`GANTUS_REVIEW_FROM_COLUMN_IDS` lists the only source columns (142 and 143).
Missing both skips the move with `not-configured`. An unknown target or partial
configuration is an error. Already in the target is `already` with no write. A
card in any other column is `source-not-allowed` and is not rolled back from a
later stage.

After the text and QA writes, the move uses a fresh board snapshot and finds
only the same card by `id`. The fresh `desc` must equal the published body, the
current assignee must still be the authenticated employee, and the column must
equal the column read before the writes. A replaced or missing card, changed
description, other assignee or changed column blocks the move. Only then is
the existing ordered move reused; exactly one transition into the configured
review column is sent.

Success is one JSON object:
`{synced, taskKey, mr:{iid,operation}, description:{updated}, qa:{commented,
deduplicated}, reviewMove:{moved,reason,columnId?}}`. A write error reports the
completed steps, the unconfirmed step and the dependent work not started; an
ambiguous POST/PATCH is never retried. GitLab, Gantus edit/comment/move and local
review outcomes stay separate.

Resume after an unconfirmed write by reading first: the MR by `iid` (or the
existing MR list for that branch), the card by `id`, its comments and the board.
Compare the observed body, author, description, assignee and column with the
attempted values, then run only the missing step with a fresh `sync` receipt.
Never replay a blind POST/PATCH and never claim a no-op comment or move from an
equal description alone.

## Review merge and testing move

`review-merge` is the one executable path that merges a reviewed clean MR
through `bin/gitlab-api.mjs` and then considers the single board transition
review → testing. `post-merge` is its read-only reconcile: it never sends the
merge PUT, never patches the card, and only re-verifies an already merged MR by
`iid` and reports the actual card column and status.

Both commands take the authoritative MR URL (`--mr-url`) from the review
report, not a local receipt, local `HEAD` or branch, plus the numeric
`--project-id` pinned from the origin project during review. The URL must be
HTTPS (a loopback fixture reaches it through the fake client) and must contain
no credentials, query or fragment, and must resolve to the project of
`GANTUS_GIT_REMOTE` and that `iid`. `--source-branch` must contain exactly one strict key equal to
`--key`; the target equal the MR target. `post-merge` names them
`--source-branch` and `--expected-target-branch`, and `--expected-sha` is the
reviewed `head_sha`.

Before any merge request `review-merge` proves, in this order:

- board identity and route: the card resolves from `--key` alone and its `id`
  equals `--card-id`; its `name` and `desc` SHA-256 equal `--name-sha256` and
  `--desc-sha256`, so a late requirement edit blocks the merge; `editProtected`
  allows the authenticated user; the resolved review column and testing target
  exist and differ (their ids are pinned internally, not passed in); the card
  is in review or already in testing.
- discussions: every page of `GET .../discussions` (100 per page, bounded at 50
  pages) is read. An open resolvable thread blocks. Standalone non-resolvable
  notes are not threads; the reviewer reads them and an actionable comment
  blocks the clean verdict in the report. A malformed note or discussion —
  including an empty `notes` array or a missing/contradictory
  `resolvable`/`resolved` flag — is never complete and blocks.
- the same route, key, `id`, fingerprints and ACL are re-checked on one fresh
  board snapshot after all discussion pages, immediately before the final MR
  GET and PUT, so drift during page reads blocks the merge.
- MR state from a fresh `GET .../merge_requests/:iid`: `iid`, equal numeric
  project/source/target ids equal to `--project-id` (a fork or a re-resolved
  project blocks), `web_url`, source and target branches match the pins;
  `state:"opened"`, `draft:false`, `detailed_merge_status:"mergeable"`,
  `blocking_discussions_resolved:true`, `has_conflicts:false`,
  `force_remove_source_branch:false`; every present source-head field
  (`diff_refs.head_sha`, `sha`) equals the reviewed pin — one stale or
  mismatched field blocks even when the other matches.

Only then is one `PUT .../merge` sent with
`{sha:<head_sha>,should_remove_source_branch:false}` through the strict
single-attempt transport: a second outbound write is never attempted. A
definitive 4xx rejection (400/401/405/409/422) is reported as failed and not
retried. A 2xx body is accepted only when it already proves
`state:"merged"`, `draft:false`, a parseable `merged_at`, the reviewed source
head, and, when present, `merge_user.id` equal to `--gitlab-user-id`; a
complete-looking 2xx with an incomplete or malformed receipt is settled by one
authoritative `GET` of the same `iid`, and only a proven merge then uses the
normal board move. A genuinely ambiguous transport — timeout, network failure
or 5xx — is different: the PUT is never repeated, at most one read-only `GET`
of the same `iid` is allowed, and **no board write ever follows** even when that
GET proves the merge. The result is then `merged:true` with
`testMove:{moved:false,reason:"ambiguous-merge"}`; recovery needs fresh explicit
consent. If the GET does not prove the merge, the GitLab outcome is reported as
unconfirmed and only the separate read-only `post-merge` may check it. A
legitimate fast-forward or squash merge keeps the source head, so
`merge_commit_sha` is not required. An open, draft, foreign, re-revised or
otherwise unproven MR is never moved.

`post-merge` repeats the identity, branch, project, `web_url` and reviewed-head
checks on the authoritative GET, requires `state:"merged"`, and never sends the
merge PUT or any card PATCH. It returns the confirmed MR plus the actual card
`columnId`, column name and status. Use it after an ambiguous merge outcome or
a restart; recovery only re-reads `GET .../merge_requests/:iid` for that `iid`.
Moving a card after a confirmed merge is a separate action that requires fresh
explicit consent; it is never automatic and `post-merge` does not perform it.

The board move belongs to `review-merge` and runs only after the merge is
confirmed. `--card-id` must match the card resolved from the key; a missing,
replaced, duplicate or reassigned card blocks and is never guessed from a title
or local `HEAD`. Only `editProtected` is enforced: admin, creator or assignee
may move, so a reviewer's colleague is allowed when the existing ACL allows it.
`assignee` and `teamComments` are not gates here because this step only moves a
card; nothing is commented or rewritten.

The testing target is the exact `GANTUS_TESTING_COLUMN_ID`, otherwise the one
board column whose observed machine status is `testing`; zero or several, or a
configured id whose observed status contradicts `testing`, block. The allowed
source is only the review column (configured `GANTUS_REVIEW_COLUMN_ID` or the
one `review` status column); there is no separate testing-source list. A card
already in testing is `{moved:false,reason:"already"}` with no write. A card
whose current column differs from review is `column-changed`; both return
without a write, so a later, paused, blocked or unrelated column is never rolled
back.

Only the expected card in review is moved. The source and target ids, key, card
`id`, requirement fingerprints and ACL are the ones computed before the merge
PUT; after the confirmed merge one fresh board snapshot must still contain the
same unique key and id, the same unchanged requirements, the same source and
target ids and a passing edit ACL. Another target, a duplicate key, a changed
description or a column that moved on all block without a PATCH. Exactly one
card PATCH with `{columnId,orderedIds}` is sent, then one read confirms the new
column and the same card key. An unconfirmed or ambiguous move is reported and
never retried.
Success is
`{merged:true,taskKey,mr:{iid,sha},testMove:{moved,reason?,columnId?}}`;
`merged:true` is returned independently of `testMove`. A Gantus failure is
separate from the successful GitLab merge: report the merge as done and the
move as `{moved:false,reason:"failed"|"unconfirmed"}`, never re-merge and never
send another PATCH automatically; recovery is read-only `post-merge` and a
separate explicitly consented action. An ambiguous merge outcome uses
`{moved:false,reason:"ambiguous-merge"}` and never reaches any board request.

## Review-ready

This is the legacy create-only path; new create and update flows use `sync`,
and both are never run for one MR. The caller runs this only after its own
confirmed GitLab MR **create** POST. Reuse that POST stdout without another MR
request and pass a minimal receipt with `iid`, `web_url`, `source_branch`,
`state` and `draft`; store nothing else.
`review-ready` validates all of them before the Gantus network:

- the receipt exists and is a create result supplied by the caller, not an
  update, dry run or draft;
- `state` is `opened` and `draft` is exactly false;
- `source_branch` equals the current local branch and contains exactly one
  strict `STR-<digits>` key, which equals `--key`;
- `web_url` equals the project derived from `GANTUS_GIT_REMOTE` for that `iid`;
- `GANTUS_GIT_REMOTE` equals `origin` exactly.

Then it reads the current board and moves the card to the single review column
under the normal edit guard. A Gantus error is reported separately from the
successful MR and nothing is retried. Preparing MR text, reviewing someone
else's MR and updating an existing MR never trigger this command.

## Branch rename

The user supplies the exact branch name; never derive it from a title, slug or
example. Before any change:

- `git check-ref-format --branch` passes; option-like names and `@{-N}` are
  rejected;
- the target branch does not exist and differs from the current branch;
- HEAD is attached, the current branch is not a canonical base branch and is
  not the branch pointed to by `refs/remotes/origin/HEAD`;
- the branch has no configured upstream and no local remote-tracking ref with
  the same name;
- the target name contains exactly one strict STR key equal to `--key`, and
  that task exists on the configured board.

Rename uses `git branch -m -- OLD NEW`, so a concurrent checkout cannot rename
another branch. After the network checks and immediately before the rename,
the current branch name, base/default branch, published evidence and target
collision are checked again; a change there aborts without renaming. It then
verifies that HEAD and the full `git status --porcelain` state are unchanged.
No force, push, checkout or reset. Published detection is local: it cannot
prove that a stale or unfetched remote ref does not exist.

## Independent fixes outside the branch

An explicit request to create working branches for completed local changes is
a standalone branch-only flow: it may create linked cards and fill QA, but it
never pushes, opens or updates an MR or advances a card. A request for an
ordinary branch with an exact user-supplied name is not this flow and creates
no card by itself.

1. Classify the whole local diff into independent work units by goal and
   acceptance criteria, not by file. Several independent work units stay
   separate and never share one new card, key or branch. Keep staged, unstaged and untracked state;
   never reset, stash, clean, checkout with overwrite or force. Do not capture
   another task's hunks.
2. A branch that already has the correct task or key keeps it. A distinguishable
   independent fix on base or without a key reuses an existing confirmed key
   only when the goal and criteria match; otherwise create exactly one card per
   unit. After a confirmed create, reuse the returned key even if branch
   creation fails; never create a duplicate.
3. A fix already committed on base or on a foreign branch is not moved by
   guessing. Inspect the commits, author and diff, isolate only the proven
   change, and move it only after an unambiguous check; otherwise ask one
   targeted question. When the changes are already on the target branch, do not
   create an empty MR, reset or cherry-pick an empty commit.
4. Create `<prefix>/<key>` from the resolved base, preserve unrelated staged,
   unstaged and untracked changes, and add a QA comment only when no confirmed
   identical comment exists. A previous confirmed card/key or QA is retried by
   reading first; if the state cannot be proven, offer a manual read-only
   reconciliation instead of a duplicate write.

Ask a targeted question for mixed hunks, unclear base, dates, name collision or
ownership. Never include the independent fix in the original MR or rewrite base
history.

## Disable and remove

Without the environment, the skill does nothing. To remove the integration,
delete `skills/gantus/` and its installed skill link, then delete the optional
Gantus paragraphs in `skills/git-flow/reference/mr.md` and
`skills/review/SKILL.md`. No OpenCode or harness runtime setting is involved.

## Open live boundary

Local loopback fixtures prove the documented web contract and safety guards.
They do not prove a live Gantus instance, its session/CSRF behaviour, ACL
answers, the comments read used for QA dedupe, review-column metadata, or the
exact create response. A live read/create/edit/comment/move/sync on a separately
provided test board remains open and must not be replaced by fixture results.
