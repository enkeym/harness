---
name: git-flow
description: Branching, autocommit and the Jira/MR chain for this user's repositories — when to commit without asking, why the ticket number must be in the branch name, who writes the commit message, and what stays with the human. Load before creating a branch, before committing a finished unit of work, or before writing any Jira or merge-request text.
---

# Branches, commits, Jira

## The branch carries the ticket

`feature/STR-620` — the ticket number in the branch name is the only place the
commit agent reads it from. A branch named without it loses the Jira link
silently, and no later step can recover it. No ticket at all — `feature/<slug>`.

Branch off the branch the repo actually develops from: usually `dev`, not `main`.
No worktrees; the user switches branches often and expects a switch back to be
free.

## Commit as soon as a unit is done

A plan task, a `/team` subtask, a verified bounded edit, a green fix — commit
right away, without asking:

```
opencode run --agent commit --dir "$(git rev-parse --show-toplevel)" "без push"
```

It takes 1–3 minutes; give it a timeout of 300000. Empty instructions — pass
`закоммить`.

Never commit unfinished work, red tests, files outside the task, or secrets.

## The commit agent owns the message

It reads the diff and writes the Conventional Commits header in the repo's style,
and from the branch name it writes the Jira `Summary` / `Description` and the MR.
So: **don't hand-write commit messages or Jira text yourself while this agent is
available.** Show its output — hash, push result, MR, Jira block — verbatim, and
don't tidy up after it. If it fails, show the error and offer a retry.

`/commit` typed by the user is their decision to commit **and push** this branch;
the plain autocommit above stays local.

## What stays with the human

Push, merge and MR creation. Confirm before `git push`, `gh pr create`, a merge,
a force push or anything touching a protected branch — security-guard will ask
too, and its prompt is not a formality.
