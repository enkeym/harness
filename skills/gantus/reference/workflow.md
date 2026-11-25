# Gantus workflow reference

Optional integration for one configured board. Load only for an explicit user
request or the single post-MR review step. Everything is local: no live Gantus
run is part of the test suite.

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
| `GANTUS_GIT_REMOTE` | Exact `git remote get-url origin` for this repository. Required by `review-ready` and `rename-branch`; another project cannot feed its STR into them. |

Validation happens before any request. Missing or invalid values exit 2 and
send nothing. HTTP redirects are not followed, proxies are disabled, and the
cookie travels only in the request header. The HTTP opt-in permits that exact
origin but never encrypts traffic, so trust the whole network path.

## Commands

Run `node <base>/scripts/gantus.mjs` with one of these commands from the target
repository; `<base>` is the resolved `gantus` skill directory and the working
directory stays the repository under work:

```
get --key STR-12
create --name TEXT --desc TEXT --start YYYY-MM-DD --end YYYY-MM-DD --priority P0|P1|P2|P3
edit --key STR-12 [--name TEXT] [--desc TEXT] [--priority P0|P1|P2|P3]
comment --key STR-12 --body TEXT
move --key STR-12 (--column COLUMN_ID | --to review)
review-ready --key STR-12 --mr RECEIPT_FILE_OR_JSON
rename-branch --key STR-12 --branch EXACT_BRANCH_NAME
```

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
A
2xx response must contain a safe `taskKey` and `id`. A 2xx without them, a 5xx
or a timeout is an ambiguous write: report it, never repeat the POST. A single
POST does not promise placement in a manually chosen column; Kanban placement
may need its own card PATCH.

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

## Review-ready

The caller runs this only after its own confirmed GitLab MR **create** POST.
Reuse that POST stdout without another MR request and pass a minimal receipt
with `iid`, `web_url`, `source_branch`, `state` and `draft`; store nothing else.
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

## Disable and remove

Without the environment, the skill does nothing. To remove the integration,
delete `skills/gantus/` and its installed skill link, then delete the two
optional paragraphs in `skills/git-flow/reference/mr.md` and
`skills/review/SKILL.md`. No OpenCode or harness runtime setting is involved.

## Open live boundary

Local loopback fixtures prove the documented web contract and safety guards.
They do not prove a live Gantus instance, its session/CSRF behaviour, ACL
answers or the exact create response. A live read/create/edit/comment/move on a
separately provided test board remains open and must not be replaced by fixture
results.
