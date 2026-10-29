---
name: commit
description: "Commits the current changes and pushes the branch — message written from the diff in the user's own style. User-invoked as /commit."
---

# /commit

`/commit` = commit **and push** this branch. Write the commit yourself.

Load review-standards, review-security and git-flow; review the diff before committing.

1. One line: branch (`git branch --show-current`) and `git status --short`.
   Nothing to commit → say so, stop.
2. [../shared/review-pass.md](../shared/review-pass.md) on the diff and on
   untracked files; fix findings inside the diff by `review-standards` step 8.
   Classify suspected secrets before acting; a confirmed secret blocks publication.
   Fix certain in-scope findings autonomously. Stage only the task's paths or
   hunks, inspect the entire cached diff (including previously staged changes),
   and commit (`git commit -F -` for multi-line). Preserve unrelated staged and
   unstaged work; never use `git add -A` across the whole tree.
3. Push as `git-flow` says. **No merge request, no Jira block** — those come
   only on an explicit request.

Arguments after `/commit`: a quoted message is the header verbatim;
instructions like "без push" are followed. Never change git signing settings.
