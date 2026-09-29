# Stormapi repositories

Applies to every repository whose `origin` is on `git.stormapi.su`; elsewhere
ignore this file. These are the project facts `rules/core.md` resolves first —
a project's own `CLAUDE.md` still wins where it says otherwise.

## Branches

- Ticket: `STR-XXX`, from the branch name or the user; never invented.
- A task branch is `feature/STR-XXX`, always cut from a fresh `dev`, never from
  the current or another feature branch — its commits would land in the MR:

  ```bash
  git checkout dev
  git pull --ff-only
  git checkout -b feature/STR-XXX
  ```

- Never commit or push to `dev` or `main` directly: work goes to
  `feature/STR-XXX` and reaches `dev` through an MR. Push to `dev` deploys the
  dev stand, push to `main` deploys prod.
- Work started on the wrong branch → create the right one from `dev` first,
  then carry the changes over.

## Commits

- Header: `[STR-XXX] ` + a short line; the rest in the form of the user's
  recent commits in this repository (`git-flow`), e.g.
  `[STR-217] feat: add scope to user accesses`.
- Body optional: a couple of lines when the header does not say what changed
  and why.
- No `Co-Authored-By`, no AI or tool mention (see `git-flow`).
