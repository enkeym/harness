---
name: commit
description: Commit the current changes through the OpenCode `commit` agent (GLM 5.3) — message written from the diff in the repo's style, branch push, GitLab MR and a Jira block. User-invoked as /commit; never self-triggered.
disable-model-invocation: true
allowed-tools: Bash(opencode run --agent commit:*), Bash(git status:*), Bash(git branch:*), Bash(git rev-parse:*)
argument-hint: [commit message, or instructions for the agent]
---

# /commit

Claude does not write the commit — the OpenCode `commit` agent does: it reads
the diff, writes the message in the repo's style, pushes the current branch and
updates the GitLab MR. The user typing `/commit` is their decision to commit and
push this branch.

1. Show the branch and changed files in one line: `git branch --show-current`,
   `git status --short`. Nothing changed — say so and stop, don't run the agent.
2. Run the agent from the repo root (timeout 300000, it takes 1–3 minutes):

```
opencode run --agent commit --dir "$(git rev-parse --show-toplevel)" "$ARGUMENTS"
```

   Empty arguments — pass the string `закоммить`. Text after `/commit` goes to
   the agent as is: either a ready commit message or instructions ("без push",
   "подробнее для Jira").
3. Show the agent's output (hash, push result, MR, Jira block) verbatim, no
   retelling. Don't commit anything yourself and don't fix things up after the
   agent: if it fails, show the error and offer to retry.
