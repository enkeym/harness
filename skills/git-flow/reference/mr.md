# Merge request and Jira text

Procedure, format and delivery for an MR the user asked for. Trigger and
commit rules: [../SKILL.md](../SKILL.md).

## Procedure

1. Classify and prohibit: resolve the base branch; project memory or rules
   banning delivery → no API, the chat block is the whole result. An ordinary
   review, commit, push or MR-text request never writes Gantus. An explicit
   publish or update request runs this route; a plain MR in another repository
   does not depend on Gantus and never calls its board.
2. Read-only intake before any push or MR write. With `gantus` in the active
   skill catalog and an explicit request, load it by exact id and run `preflight`
   from the target repository; it derives the exact single strict key from the
   current named `source_branch`, never from the title or local `HEAD`. Pass
   `--key <STR>` only when that key is already confirmed; it must equal the
   branch key. `configured:false` or `applicable:false` for another repository
   or remote means the board does not apply: a plain MR continues ordinary
   GitLab delivery without a board call, while an explicit Gantus request stops
   instead of degrading. A matching configured repo without a branch key
   returns `needsLink` with `ready:false` and `reason:"no-key"`: stop plain
   publication and run the scoped branch-only route (reuse or create exactly one
   linked card, name the branch `<prefix>/<key>`, repeat preflight), or ask one
   targeted question and stop. A non-zero exit, invalid or incomplete active
   configuration, a fatal preflight reason or a mismatched explicit key blocks
   publication; never invent `--key`. Read the GitLab `user` once for the
   numeric user id, resolve the numeric `project.id` from the origin, and list
   open MRs for `source_branch`. Several matches, fork or project mismatch, a
   `source_project_id` or `target_project_id` that differs from the numeric
   `project.id`, another `target_branch`, Draft, or a foreign `author.id`
   blocks before any write. Zero matches → create; exactly one → update. No
   push yet.
3. Requirements and internal review: inventory
   `git log --no-merges --format='%h %s' <base>..HEAD` and
   `git diff <base>...HEAD --stat`; sort behaviour and mechanical hunks, group
   behaviour into user-visible entities, locate them in the UI, draft in the
   format below, then run its fact, coverage and word checks. Read the card and
   compare every mandatory requirement with the final diff, including boundary
   cases; a missing mandatory result blocks publication. Confirmed extras are
   reflected separately, an independent fix stays out, review fixes are
   rechecked against the final diff. Run the internal review pass; never publish
   review notes. Do not start a separate reviewer unless the user requests it.
4. Mandatory checks: load `test-conventions`; run the project's full test
   suites and required typecheck/lint/build checks after the last fix. Reuse
   successful results only while their relevant inputs are unchanged. Fix
   in-scope failures; failed or blocked required checks block publication.
   If a required check exposes a bug and its fix changes the diff, return to
   step 3: recheck every requirement, rerun the internal review and rebuild
   the body, then repeat these checks. Push only the exact `HEAD` SHA and
   content that passed them. `test-coverage` is loaded only for an explicit
   coverage request.
5. Commit fixes using the normal standards and security checks. Revalidate the
   branch, `HEAD` SHA, project scope and staged paths immediately before the
   push; no unrelated change enters the commit.
6. Push once after the last commit and successful checks. An explicit MR
   request authorizes this push. The pushed SHA and content must equal the
   reviewed and checked one; any later change invalidates both and returns to
   step 3.
7. MR write: use the candidate read in step 2, the final body from step 3 and
   exactly one POST/PUT as described in *Opening the MR in GitLab*. For an
   applicable Gantus update, re-read the exact `!iid` immediately before the
   PUT and stop on description or metadata drift, or a failed GET, without the
   PUT and without sync; a push already made is reported separately. Check the
   returned `iid`, URL, state, target and author; an ambiguous response is
   never retried.
8. Gantus sync only after the caller's own confirmed POST/PUT, then report what
   actually completed. Jira text stays a chat block with no API.

## Format

Summary `<TICKET> <Type>: <суть всей ветки>`, type from the branch prefix:
`feature/`→`Feature:`, `fix|bugfix|hotfix/`→`Bugfix:`, `refactor/`→`Refactor:`,
`chore/`→`Chore:`. No ticket in the branch → omit the ticket and Closes line
unless project rules require one. One headline for the whole
branch — raise the level instead of joining two with "и". Placeholders below
stay placeholders:

```
<TICKET> Feature: Экспорт и импорт данных в <разделе>

1. <Раздел> → рабочая область — добавлена кнопка «Экспорт» с выбором формата.
2. <Раздел> → «Импорт» — файл загружается с исходными именами записей.
3. Внутренние изменения без влияния на интерфейс: общий код экспорта, тесты.

Проверить:
1. <Раздел> → «Экспорт» → выбрать формат → файл скачан в этом формате.
2. Загрузить этот файл через «Импорт» в другой <объект> → исходные имена.

Closes <TICKET>
```

- Plain words, as told to a tester; past tense, no "я". No headings, bold,
  nested bullets or test-gap lines — check results stay in the delivery report.
- One item per entity, `<Где> — <что изменилось>` in one or two sentences;
  the internal item last, dropped when empty. Commits of another ticket →
  "Также доработки <OTHER-TICKET>: …".
- Place in the UI's own labels, `<Страница> → <Раздел> → <Элемент>`; role when
  access is restricted: "для администратора".
- Effect, not implementation: "имена импортированных записей сохраняются как в
  файле", not "убрана серверная нумерация". Refactor or tests with a visible
  effect → the effect; none → the internal item.
- `Проверить`: `<Где> → <действие> → <результат>`, one item per changed
  behaviour, on one place that shows it. A changed constant → what it drives,
  not its module; a changed shared function → one item per new behaviour,
  none for callers that only follow its signature, even when asked for detail.
- Toast and error texts only when the change is about them.
- Banned: "Данное изменение", "В рамках задачи", "Реализована функциональность",
  "Таким образом", marketing wording.

## Opening the MR in GitLab

Use the shared client `node ~/.config/harness/repo/bin/gitlab-api.mjs`.
It uses existing glab authorization for the explicit host; GITLAB_TOKEN,
GLAB_TOKEN or GITLAB_ACCESS_TOKEN is a fallback only when the client cannot
start or read its configuration. Never read credential stores, print tokens,
run login, or infer an expired session from a filesystem/network failure.
The client enforces timeouts, validates HTTP/JSON and returns nonzero on failure.
Never pipe an unchecked curl request into jq. Never retry an ambiguous POST.

`git remote get-url origin` (`https://<host>/<group>/<repo>.git` or
`git@<host>:<group>/<repo>.git`) → `<api>` =
`https://<host>/api/v4/projects/<group>%2F<repo>`, every `/` of the path
encoded, written out in full.

1. Classify before acting. An ordinary review, commit, push or MR-text request
   never writes Gantus; a project publication ban ends the route. A plain MR in
   another repository is not a Gantus request. With `gantus` in the catalog and
   an explicit request, load it by exact id and run
   `node <gantus-base>/scripts/gantus.mjs preflight` with the target repository
   as the unchanged cwd. It derives the key from the current named
   `source_branch`, never from the title or local `HEAD`; `--key <STR>` is an
   optional equality check, never invented. Do this before any GitLab or
   Gantus write, separate from the post-confirmation `sync`.
   - `{configured:false}` or `applicable:false` for an unrelated repository or
     remote: Gantus does not apply here; continue ordinary GitLab delivery
     without a board call. `GANTUS_GIT_REMOTE` alone does not activate it.
   - `{applicable:true, ready:false, reason:"no-key", needsLink:true}` for a
     matching configured repo: this is the link gate, not a plain-MR pass. Run
     the scoped branch-only route or ask one targeted question and stop; after
     the branch has the one confirmed key, repeat preflight.
   - `{applicable:false}` for an explicit Gantus request, a non-zero exit,
     invalid or incomplete active configuration, or a fatal reason: stop
     publication before push. Never degrade an explicit Gantus request into a
     plain MR. A configuration error is not absence. Failure output never echoes
     the configured or actual git remote, because a URL can contain credentials.
   - `ready:true`: keep the returned card `id`, `desc`, assignee and testing
     plan. A matching remote blocks on several keys/cards, a mismatched key,
     another current assignee, disabled team comments or an unknown configured
     testing target. A later column is a reported skip, not a failure.
2. Read-only GitLab candidate check before any push. Obtain the current numeric
   `user.id` once from the existing client. Resolve the numeric `project.id`
   from the origin, then make exactly one reading of
   `projects/<encoded-project>/merge_requests?source_branch=<encoded-branch>&state=opened`.
   Zero matches → create; one match → update; several, fork or project
   mismatch, a different `target_branch`, `state`, Draft or a foreign
   `author.id` → block without a write. Read the current MR `description`
   before an update and pass it later as `--expected-mr-desc`. That read pins
   `author.id`, `state`, `draft`, `source_branch`, `target_branch`,
   `source_project_id` and `target_project_id` as the baseline for the pre-PUT
   re-read. A PUT is allowed only when the read MR author matches the caller's
   `user.id`. Do not push before this check.
3. Requirements, body and internal review. Read the card with
   `get --key <STR>` when preflight did not already return its `desc`; build one
   safe final body from mandatory requirements, confirmed extras, preserved
   manual context and no review notes or secrets. Compare every mandatory
   requirement and boundary case with the final diff: a missing mandatory
   result blocks publication; confirmed extras are reflected separately, an
   independent fix stays out, and review fixes are rechecked. Use the same body
   for the MR and `--desc`; pass the card `desc` read before publication as
   `--expected-desc` and its `id` as `--expected-card-id`. For an update, pass
   the existing MR description as `--expected-mr-desc`. The final body must
   retain every block present on only one side; generated blocks common to both
   may be replaced only when named through `--replaced-desc`. A losing,
   duplicated or stale merge blocks before publication. Text that starts with
   `---`, `--` or ends in significant whitespace uses `--desc=value`,
   `--qa=value` or the matching `--*-file <path>`; never let the shell strip it.
4. Mandatory checks after the last fix: the project's full test suites and
   required typecheck/lint/build. Reuse successful results only while their
   relevant inputs are unchanged; failed or blocked required checks block
   publication.
5. Commit fixes using the normal standards and security checks. Then revalidate
   the branch, `HEAD` SHA, project scope and staged paths; no unrelated change
   enters the commit.
6. Push once after the last commit and successful checks. An explicit MR
   request authorizes this push.
7. MR write. For an update when the Gantus integration applies, re-read the
   exact `!iid` immediately before the PUT and require the same `description`
   as the pinned `--expected-mr-desc`, and the same `author.id`, `state`,
   `draft`, `source_branch`, `target_branch`, `source_project_id` and
   `target_project_id` as the step 2 read. A changed description, any other
   drift or a failed GET stops without the PUT and without sync; a push already
   made is reported separately. This check is not compare-and-swap. An ordinary
   MR outside the Gantus scope keeps its existing route without this gate.
   Write one JSON body file with `source_branch`, `target_branch`,
   title and the final description. Call
   `node ~/.config/harness/repo/bin/gitlab-api.mjs --hostname <host>
   --method POST --input <body.json> projects/<encoded-project>/merge_requests`;
   an update uses `--method PUT --input <body.json>
   projects/<encoded-project>/merge_requests/<iid>` with only title and
   description. Check exit status, `iid`, `web_url`, `state`, `target_branch`,
   `author.id` and the returned description. No labels, assignee, milestone,
   squash flags. The user's explicit MR request authorizes this delivery; do
   not rely on a hook confirmation. Success →
   `MR !<iid> создан: <url>` (or `обновлён`), after the test results. A failed
   call → one line distinguishing authorization, permissions, network or local
   config access; retain the prepared body and report its path. Continue
   authorized local work. Do not hand the user a login or secret-reading step.
   Scenario: the step 2 read captured manual context, then the user appends a
   note to the MR before the PUT. The pre-PUT read sees a different description
   and stops: no PUT, no sync, no comment changes; the appended note stays.
8. Gantus sync only after the caller's own confirmed create or update:
   load `gantus` by exact id and run
   `node <gantus-base>/scripts/gantus.mjs sync --key <STR> --mr <json> --desc <body> --qa <text> --gitlab-user-id <id> --expected-desc <read-desc> --expected-card-id <id> [--expected-mr-desc <read-mr-desc>] [--replaced-desc <old-generated>]`
   with the target repository as the unchanged cwd. Take the current GitLab
   user id from the existing client's `user` result. The receipt is the same
   confirmed POST/PUT response, extended with `operation` (`create` or
   `update`), `author.id` and `description`. `No second MR request` means no
   duplicate POST/PUT and no post-confirmation GET to recreate the receipt; the
   single pre-PUT verification read required by step 7 is not a duplicate
   mutation. The body prepared in step 3 is already final; a mandatory
   requirement gap stops
   publication before the write, confirmed extras are reflected, an independent
   fix stays out of this MR, review fixes are rechecked, and review notes are
   never published as MR comments. For an update, the final body must retain
   distinct manual blocks from both the card and the existing MR, with
   generated shared blocks once; a losing or duplicated merge blocks. A
   different current card description blocks the write instead of replacing
   the latest manual edit; equal values are a no-op. This is not a
   compare-and-swap promise: report a conflict and re-read.

   QA is one readable comment for the changed behaviour, steps and expected
   result; never claim a manual run that did not happen and never copy task or
   foreign review text. `sync` reads the bare comments array and reuses only the
   current account's exact MR, branch and body, comparing `authorId` with the
   authenticated user `id`; a missing or invalid author blocks and a foreign
   exact body is a conflict. Body equality ignores terminal line endings only;
   internal blank lines, spaces and other text stay significant. A substantive
   change adds a new QA.

   There is no documented machine testing status. The target is the exact
   `GANTUS_TESTING_COLUMN_ID` and only source columns in
   `GANTUS_TESTING_FROM_COLUMN_IDS` are promoted. Missing both reports
   `not-configured` and skips the move; a later column reports
   `source-not-allowed` and is not rolled back; an unknown target blocks.
   Already in testing is `already` with no write. After the text and QA writes,
   the move re-reads only the same card `id` and requires the published
   description, current own assignee and original column; a replaced card,
   manual edit, reassignment or column change blocks the move. Exactly one
   transition is sent.

   Report what actually completed, the unconfirmed step and the dependent work
   not started. Never retry an ambiguous POST/PATCH; a valid empty 2xx is
   accepted, but a write without an observable read-back change does not
   advance. After an ambiguous write, resume read-first: read the MR, card,
   comments and board, compare observed values, then run only the missing step
   with a fresh receipt. A GitLab failure, local review failure and Gantus
   edit/comment/move failure stay separate; a Gantus failure never turns the MR
   result into a failure. Skip without the skill or its configuration; a
   missing optional integration is not an active configuration error. A
   project publication ban is stronger than this flow.

Legacy `review-ready` is used only when the installed CLI has no `sync`
command; never run it together with step 8 for one MR. Only after the caller's
own confirmed MR **create** POST on this branch — never for PUT/update, draft,
dry run or failure — take exactly one `STR-<digits>` from that response's
`source_branch`, not from the title, and reuse the same POST stdout as a
minimal receipt (`iid`, `web_url`, `source_branch`, `state`, `draft`). Make no
second MR request and store nothing else. Run
`node <gantus-base>/scripts/gantus.mjs review-ready --key <STR> --mr <json>`
with the target repository as the unchanged cwd. Skip without the skill or
its configuration; a Gantus error is reported separately and never retried.

## Branch-only work

An explicit request to create working branches for completed local changes
creates cards and branches only; it never pushes, opens an MR or advances a
card. Split the diff into independent groups by goal and acceptance criteria,
one card/key/branch per group. Reuse an existing confirmed key only when it
matches; never duplicate a card, branch or QA comment. Preserve unrelated
staged, unstaged and untracked state; no reset, stash, clean or force. A
committed fix on base or a foreign branch is moved only after an unambiguous
check, otherwise ask one targeted question. If the changes are already on the
target branch, do not create an empty MR or reset. An ordinary branch request
with an exact user-supplied name creates no card by itself.
