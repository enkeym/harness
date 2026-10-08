# Merge request and Jira text

Procedure, format and delivery for an MR the user asked for. The trigger and
the commit rules are in [../SKILL.md](../SKILL.md).

## Procedure

1. Base: the resolved base branch. MR delivery restricted by the project's
   memory or rules file → no GitLab API, the block below in chat is the
   whole result. Otherwise the MR goes through the API (last section).
2. Tests: `test-coverage` on `<base>...HEAD`, report first. Red suite → stop,
   no MR text until the user decides.
3. Review: [../../shared/review-pass.md](../../shared/review-pass.md) on
   `<base>...HEAD` — the whole branch, links between commits included.
   Critical or Important → report, stop until the user decides.
4. Inventory: `git log --no-merges --format='%h %s' <base>..HEAD` and
   `git diff <base>...HEAD --stat`. Whole branch, nothing outside it.
5. Sort each commit's hunks by its removed and added lines: **behaviour** —
   something a user or the API sees differently (a value, a condition, a
   message, a new element, a fixed bug) — or **mechanical** — a call site
   following a new signature, a rename, a move, formatting, types. Being in
   the `tokensave_callers`/impact list does not make a file a behaviour
   change. Mechanical hunks go to the internal item only, with no check.
6. Group behaviour hunks into **entities** — things the user sees: a page, a
   panel, a dialog, a profile section. Not modules, not files.
7. For each entity, find the exact UI location and role: read the component
   and `rag_search` for the button/section labels. A description without a
   location is not done.
8. Draft in the format below. Project memory or rules file has a sample →
   match its vocabulary for entities and places.
9. Fact check: every "раньше…" or "теперь…" claim must be visible in the
   removed or added lines; a claim the diff does not show → delete it.
10. Coverage check: every commit maps to a numbered item or to the internal
    item. An unmapped commit → add it.
11. Word check: no code identifiers (camelCase, snake_case, file paths, HTTP
    verbs, endpoints, tables, migrations, library names), no banned phrases.
12. Deliver: *Opening the MR in GitLab*. A Jira request → the block in chat,
    Jira has no API here.

## Format

Summary: `<TICKET> <Type>: <суть всей ветки>`. Type from the branch prefix:
`feature/`→`Feature:`, `fix|bugfix|hotfix/`→`Bugfix:`, `refactor/`→`Refactor:`,
`chore/`→`Chore:`. No ticket in the branch → ask for it. One headline for the
whole branch — raise the level rather than glue two with "и".

Description in plain words, the way the user would tell a tester; past
tense, no "я":

```
1. <Где в интерфейсе> — <что изменилось, одно-два предложения>.
2. <…>
3. Внутренние изменения без влияния на интерфейс: <коротко через запятую>.

Проверить:
1. <Где> — <действие> → <ожидаемый результат>.
2. <…>

Closes <TICKET>
```

Rules:
- One item per entity; the internal item last, omitted when empty. Commits
  tagged with another ticket → item "Также доработки <OTHER-TICKET>: …".
- Place in the UI's own labels, "<Страница> → <Раздел> → <Элемент>"; role
  when access is restricted: "для администратора".
- Effect, not implementation: "имена импортированных записей сохраняются как в
  файле", not "убрана серверная нумерация". Refactor or tests with a visible
  effect → the effect; none → the internal item.
- `Проверить` covers only what the diff changed: one item per changed
  behaviour, on one place that shows it. A changed constant → what that
  constant drives, not its module. A changed shared function → one item per
  new behaviour it has; callers that only follow its new signature get none,
  even when the user asks for detail about that function.
- Toast and error texts only when the change is about them.
- No headings, bold, nested bullets or test-gap lines — gaps belong to the
  `test-coverage` report in chat.
- Banned: "Данное изменение", "В рамках задачи", "Реализована функциональность",
  "Таким образом", marketing wording.

Example of the shape (placeholders stay placeholders):

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

## Opening the MR in GitLab

Default delivery whenever step 1 allows it: the chat gets the result line,
not the text and not a command. Token: `$GITLAB_TOKEN` only — never printed,
never `~/.git-credentials`. Never `git push -o merge_request.*`: push options
reject newlines. No separate token probe (`[ -n "$GITLAB_TOKEN" ]`, `echo`):
step 1's call answers for itself — a 401 or an empty header is step 3's cause.

Host and project from `git remote get-url origin`: `https://<host>/<group>/<repo>.git`
→ API host `<host>`, project id `<group>%2F<repo>` (SSH form `git@<host>:<group>/<repo>.git`
the same); `<api>` = `https://<host>/api/v4/projects/<id>`, written out.

1. Branch pushed. `curl -sS --fail-with-body -H "PRIVATE-TOKEN: $GITLAB_TOKEN"
   "<api>/merge_requests?source_branch=<branch>&state=opened"` → an open MR
   is updated (`-X PUT <api>/merge_requests/<iid>`, title and description
   only); none → created:

   ```bash
   curl -sS --fail-with-body -H "PRIVATE-TOKEN: $GITLAB_TOKEN" -X POST \
     --data-urlencode 'source_branch=<branch>' --data-urlencode 'target_branch=<base>' \
     --data-urlencode 'title=<Summary>' --data-urlencode description@- \
     "<api>/merge_requests" <<'MR_BODY' | jq '{iid, web_url, message, error}'
   <описание>
   MR_BODY
   ```

   No labels, assignee, milestone, squash flags. security-guard asks once for
   the POST/PUT — that prompt is the confirmation, no chat question on top.
2. Success → one line `MR !<iid> создан: <url>` or `обновлён`, after the
   `test-coverage` report.
3. No token or a failed call → one line with the cause or HTTP code, then the
   Summary and the description ready to paste, and the step 1 command with
   `$GITLAB_TOKEN` left unexpanded for `! <command>`.
