---
name: commit
description: "Commits the current changes and pushes the branch — message written from the diff in the user's own style. User-invoked as /commit."
disable-model-invocation: true
allowed-tools: Bash(git status:*), Bash(git branch:*), Bash(git rev-parse:*), Bash(git log:*), Bash(git diff:*), Bash(git add:*), Bash(git commit:*), Bash(git push:*), Bash(git merge-base:*), Bash(git show:*)
argument-hint: "[commit message, or instructions]"
---

# /commit

`/commit` = commit **and push** this branch. Write the commit yourself.

Load `review-standards`, `review-security`, then `git-flow` — in that order.

1. One line: branch (`git branch --show-current`) and `git status --short`.
   Nothing to commit → say so, stop.
2. Review pass on the diff and on untracked files; fix findings inside the
   diff. A secret or a Critical stops the command. Then `git add -A`, commit
   (`git commit -F -` for multi-line).
3. Push as `git-flow` says. **No merge request, no Jira block** — those come
   only on an explicit request.

`$ARGUMENTS`: a quoted message is the header verbatim; instructions like "без
push" are followed. The no-signing rule holds regardless.
