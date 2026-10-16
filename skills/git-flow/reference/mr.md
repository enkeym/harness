# Merge request and Jira text

Procedure, format and delivery for an MR the user asked for. Trigger and
commit rules: [../SKILL.md](../SKILL.md).

## Procedure

1. Base: the resolved base branch. MR delivery restricted by the project's
   memory or rules file → no API, the chat block is the whole result.
2. Tests: `test-coverage` on `<base>...HEAD`, report first. Red suite → stop
   until the user decides.
3. Review: [../../shared/review-pass.md](../../shared/review-pass.md) on
   `<base>...HEAD`, links between commits included. Critical or Important →
   report, stop until the user decides.
4. Inventory: `git log --no-merges --format='%h %s' <base>..HEAD` and
   `git diff <base>...HEAD --stat` — the whole branch, nothing outside it.
5. Sort each commit's hunks by removed and added lines: **behaviour** — a user
   or the API sees something different (value, condition, message, new
   element, fixed bug); mechanical — a call site following a new signature,
   rename, move, formatting, types → the internal item, no check. A file on
   the callers/impact list is not a behaviour change by that alone.
6. Group behaviour hunks into entities the user sees — page, panel, dialog,
   profile section; not modules or files.
7. Locate each entity in the UI with its role: read the component,
   `rag_search` the button and section labels. No location → not done.
8. Draft in the format below; a sample in project memory or rules file → its
   vocabulary for entities and places.
9. Fact check: a "раньше…"/"теперь…" claim the removed or added lines do not
   show → delete it.
10. Coverage check: each commit maps to a numbered item or the internal one.
11. Word check: no code identifiers (camelCase, snake_case, paths, HTTP verbs,
    endpoints, tables, migrations, library names), no banned phrases.
12. Deliver: *Opening the MR in GitLab*. Jira → the block in chat, no API.

## Format

Summary `<TICKET> <Type>: <суть всей ветки>`, type from the branch prefix:
`feature/`→`Feature:`, `fix|bugfix|hotfix/`→`Bugfix:`, `refactor/`→`Refactor:`,
`chore/`→`Chore:`. No ticket in the branch → ask. One headline for the whole
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
  nested bullets or test-gap lines — gaps stay in the `test-coverage` report.
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

Default delivery when step 1 allows; the chat gets the result line, not the
text or a command. Token `$GITLAB_TOKEN` only — never printed, never
`~/.git-credentials`, no separate probe (`[ -n … ]`, `echo`): the first call
answers, a 401 is step 3's cause. No `git push -o merge_request.*` — push
options reject newlines.

`git remote get-url origin` (`https://<host>/<group>/<repo>.git` or
`git@<host>:<group>/<repo>.git`) → `<api>` =
`https://<host>/api/v4/projects/<group>%2F<repo>`, every `/` of the path
encoded, written out in full.

1. Branch pushed. `curl -sS --fail-with-body -H "PRIVATE-TOKEN: $GITLAB_TOKEN"
   "<api>/merge_requests?source_branch=<branch>&state=opened"` → an open MR
   gets `-X PUT <api>/merge_requests/<iid>` (title and description only);
   none → create:

   ```bash
   curl -sS --fail-with-body -H "PRIVATE-TOKEN: $GITLAB_TOKEN" -X POST \
     --data-urlencode 'source_branch=<branch>' --data-urlencode 'target_branch=<base>' \
     --data-urlencode 'title=<Summary>' --data-urlencode description@- \
     "<api>/merge_requests" <<'MR_BODY' | jq '{iid, web_url, message, error}'
   <описание>
   MR_BODY
   ```

   No labels, assignee, milestone, squash flags. security-guard's prompt on
   the POST/PUT is the confirmation — no chat question on top.
2. Success → `MR !<iid> создан: <url>` (or `обновлён`), after the
   `test-coverage` report.
3. No token or a failed call → one line with the cause or HTTP code, the
   Summary and description ready to paste, and the step 1 command with
   `$GITLAB_TOKEN` unexpanded for `! <command>`.
