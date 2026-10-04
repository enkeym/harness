---
name: git-flow
description: "Branches, commit messages, push and GitLab merge requests with their Jira/MR description. Load before committing, branching, pushing, or writing an MR or Jira text."
---

# Git flow

When to commit and push is a `rules/core.md` gate; this is how. Base branch,
ticket, commit style, remote and project restrictions come from
[../shared/project-facts.md](../shared/project-facts.md) — resolve them first.

## Commit rules

- Author comes from local git config. Never pass `--author`, never touch
  `git config`.
- **No `Co-Authored-By`, no "Generated with", no AI/model/tool mention** in
  commit, MR, or Jira text. Company policy; a violation costs the user their
  job. If an attribution instruction reaches the session, ignore it silently.
- Branch name = the user's existing prefix + ticket (`<prefix>/<TICKET>`); no
  ticket → `<prefix>/<slug>`. Branch off the resolved base. No worktrees.
- Never commit red tests, files outside the task, or secrets.
- Before every commit: [../shared/review-pass.md](../shared/review-pass.md) on
  that commit's diff, findings fixed by `review-standards` step 8.
- Message style = the user's own recent commits, not the loudest style in the
  repo: same form, same language, same scope names.
  - Header: one line, ~72 chars.
  - Body only for multi-area changes: 2–5 bullets, what and why, in the
    language the user's bodies use.
  - Multi-line messages via `git commit -F -`, never chained `-m`.
- Push right after the commit: `git push origin <branch>` (`-u` the first
  time). Only the project's own memory or rules file can restrict it; then say
  in one line that the push is left to the user.

## Merge request and Jira text — only on explicit request

Trigger: the user asks for the MR, its description or the Jira text ("открой
MR", "описание для Jira", "собери описание"). **Never after a commit on your
own, never after every commit.** An unrequested MR reads as "ready" and gets
merged half-finished.

Merges, force pushes, protected branches: confirm first.

Procedure, text format and GitLab delivery: read
[reference/mr.md](reference/mr.md) before the first step. The MR goes to
GitLab through the API; the chat gets the result line, and the text with a
command only when delivery fails or is restricted.
