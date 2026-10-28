---
name: review-dispatch
description: "Decides before a commit whether the diff is reviewed in this session or in a clean one through a handoff — by size, file kinds and sensitive paths. Load first on every commit, before review-standards and review-security."
---

# Review dispatch

A small or doc-only diff is reviewed here; a large or sensitive one gets a
fresh session with no sunk context (never a subagent), through `handoff`. The checklists stay in
`review-standards` and `review-security`; this skill only picks where they run.

## Verdict

1. `git -c core.quotePath=false diff --numstat --no-renames HEAD` plus
   untracked files (`git ls-files --others --exclude-standard`, lines by
   `wc -l`). Nothing → no commit, stop.
2. Per file, in order:
   - path matches the sensitive pattern → **clean**, whatever the size;
   - path matches the doc pattern → skipped;
   - otherwise its added + deleted lines go to the total; a binary file
     (`-` in numstat) → **clean**.
3. Total over 30 → **clean**. Otherwise **here**.

| Pattern   | Matches                                                                                  |
| --------- | ---------------------------------------------------------------------------------------- |
| Doc       | `docs/…`, `README*`, `CHANGELOG*`, `LICENSE*` at any depth. `SKILL.md`, `core.md`, `CLAUDE.md`, `requirements.txt` are behaviour, not docs |
| Sensitive | a path segment `migration(s)`, `auth`, `guard(s)`, `security`, `secret(s)`, `permission(s)`, `role(s)`, `payment(s)`, `token(s)`, `session(s)`, `webhook(s)`, `upload(s)`, `cors`, `crypto` (delimited by `/ . _ -`); `.env*`, `Dockerfile*`, `.gitlab-ci.yml` |

## Here

Load `review-standards`, `review-security`, `git-flow` and run
[../shared/review-pass.md](../shared/review-pass.md) as usual.

## Clean

No question about the uncommitted state: the clean session reads the tree.
Load `handoff`, write the snapshot with `Дальше`: `Read
~/.claude/skills/review/SKILL.md, продолжить на незакоммиченных`; under
`Состояние` name the verdict reason (size, or the sensitive path) and that the
commit waits for the review. Do not commit, do not load the two review skills.

## No loop

A session whose snapshot `Дальше` names `~/.claude/skills/review/SKILL.md`
or `/review`, or that read that file or ran `/review`, gets **here** at any size — a clean session that sent the commit to
another clean one would never commit.
