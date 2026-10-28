---
name: review-dispatch
description: "Decides before a commit whether the diff is reviewed in this session as is or inside plan mode (Opus under opusplan) — by file kinds and a content check of sensitive paths. Load first on every commit, before review-standards and review-security."
---

# Review dispatch

The review always runs in this session; the checklists stay in `review-standards`
and `review-security`. This skill only picks the mode: **here** on the current
model, or **plan** inside plan mode, where opusplan runs Opus. No size
threshold — a bloated context is `context-meter`'s job.

## Verdict

1. `git -c core.quotePath=false diff --numstat --no-renames HEAD` plus
   untracked files (`git ls-files --others --exclude-standard`). Nothing → no
   commit, stop.
2. Per file: path matches the doc pattern → skipped; path matches the sensitive
   pattern → candidate; anything else → ignored.
3. No candidate → **here**.
4. Each candidate: read its hunks (`git diff HEAD -- <file>`; an untracked file
   whole). **plan** when a hunk changes authorization or ownership checks,
   validation or parsing of external input, secret or crypto handling, a
   migration, CI or Docker. Only rename, comment, text or test changes →
   **here**. The path pattern is noisy (`session`, `token` in hook paths), so
   the hunks decide.

| Pattern   | Matches                                                                                  |
| --------- | ---------------------------------------------------------------------------------------- |
| Doc       | `docs/…`, `README*`, `CHANGELOG*`, `LICENSE*` at any depth. `SKILL.md`, `core.md`, `CLAUDE.md`, `requirements.txt` are behaviour, not docs |
| Sensitive | a path segment `migration(s)`, `auth`, `guard(s)`, `security`, `secret(s)`, `permission(s)`, `role(s)`, `payment(s)`, `token(s)`, `session(s)`, `webhook(s)`, `upload(s)`, `cors`, `crypto` (delimited by `/ . _ -`); `.env*`, `Dockerfile*`, `.gitlab-ci.yml` |

## Here

Load `review-standards`, `review-security`, `git-flow` and run
[../shared/review-pass.md](../shared/review-pass.md) as usual.

## Plan

1. `EnterPlanMode`.
2. Load `review-standards`, `review-security`; run the pass of
   [../shared/review-pass.md](../shared/review-pass.md) read-only.
3. Write the findings and the fix for each into the plan file, then
   `ExitPlanMode`.
4. After approval: apply the fixes, load `git-flow`, commit.
