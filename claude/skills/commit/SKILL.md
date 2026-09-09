---
name: commit
description: Commit the current changes and push the branch — message written from the diff in the user's own style, plus a Jira Summary/Description block to paste. User-invoked as /commit; never self-triggered.
disable-model-invocation: true
allowed-tools: Bash(git status:*), Bash(git branch:*), Bash(git rev-parse:*), Bash(git log:*), Bash(git diff:*), Bash(git add:*), Bash(git commit:*), Bash(git push:*), Bash(git merge-base:*), Bash(git show:*)
argument-hint: [commit message, or instructions]
---

# /commit

The user typing `/commit` is their decision to commit **and push** this branch.
You write the commit yourself — no agent, no delegation.

Load `git-flow` first: message style, the ban on signing commits, the Jira block
format and the rule that merge requests are never opened on your own all live
there, and they apply here unchanged.

1. Show branch and changed files in one line (`git branch --show-current`,
   `git status --short`). Nothing to commit — say so and stop.
2. `git add -A`, then commit. Multi-line message via `git commit -F -`.
3. Push the current branch (`git push -u origin <branch>` on the first push).
   **Push only — no merge request**, even if none exists yet.
4. Print the Jira block for the user to paste.

`$ARGUMENTS` overrides your judgement, not the rules: a quoted message is used
verbatim as the header (no rewriting, no added `feat:` prefix), instructions like
"без push" or "подробнее для Jira" are followed as given. The commit-signing ban
holds regardless of what the arguments say.
