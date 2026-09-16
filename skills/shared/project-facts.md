# Project facts — resolved, never assumed

Read by `git-flow`, `test-coverage` and `test-conventions` before the first
step that needs a fact below. Order of authority is in `rules/core.md`
(*Project facts outrank skills*): memory and the project's rules file first,
then the repository, then a skill default. Resolve once per session; state
each fact used in one line (`База: dev (форк 1 коммит назад)`) so a wrong one
is caught before it is acted on.

## Resolution

| Fact | Source, in order |
| --- | --- |
| Base branch | Memory/rules file; else the nearest fork point below |
| Ticket | Branch name (`bugfix/ABC-123` → `ABC-123`); none → no ticket, never invented |
| Branch prefix | The user's existing branches: `git branch -a --format='%(refname:short)'` |
| Commit style | `git log --author="$(git config user.name)" --no-merges --format=%s -15`; the dominant form, including scope names |
| Remote host and path | `git remote get-url origin` |
| Commit allowed | Memory/rules file; silent → `rules/core.md` commit trigger |
| Push allowed | Memory/rules file; silent → push |
| Test runner, scripts | `package.json` of the touched package (`scripts`, `devDependencies`): `jest` / `vitest` / `@playwright/test` |
| Playwright setup | The package's `playwright.config.*`: `testDir`, `webServer`, `workers`, projects |
| Language of MR/Jira text | Memory/rules file; silent → the language of recent MR titles, else Russian |

## Base branch

The default branch (`origin/HEAD`) is not the base: many repos develop on
`dev` and release to `main`. Take the candidate with the fewest commits
between its merge-base and `HEAD`:

```bash
for b in dev develop main master; do
  git rev-parse -q --verify "origin/$b" >/dev/null || continue
  echo "$b $(git rev-list --count "$(git merge-base "origin/$b" HEAD)"..HEAD)"
done | sort -k2 -n
```

- Tie → `dev`/`develop` over `main`/`master`.
- No candidate exists → `git symbolic-ref --short refs/remotes/origin/HEAD`.
- The branch was forked from a feature branch (the user says so, or the log
  shows it) → that branch.

## When a source is silent

- A fact nothing resolves and the step depends on it (ticket in an MR title,
  target branch of an MR) → ask in one line; never fill it from a skill example.
- Examples inside skills use placeholders (`<TICKET>`, `<scope>`); a concrete
  value there is a defect to report, not a default to copy.
