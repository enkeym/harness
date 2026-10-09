---
name: review
description: "Reviews a change without touching the code — uncommitted changes first, else the commits of the branch's ticket, else a scope the user picks, or the project's open GitLab merge requests — with review-standards and review-security findings and manual check steps, then an offer to fix on the user's own branch or MR draft notes on a colleague's. User-invoked as /review."
disable-model-invocation: true
allowed-tools: Bash(git status:*), Bash(git branch --show-current), Bash(git for-each-ref:*), Bash(git rev-parse:*), Bash(git log:*), Bash(git diff:*), Bash(git show:*), Bash(git grep:*), Bash(git merge-base:*), Bash(git config user.email), Bash(git remote get-url:*), Bash(git fetch:*), Bash(curl:*), Bash(jq:*), Read
argument-hint: "[branch | !MR-iid | mr | path | audit <area>] [focus, in your own words]"
---

# /review

Report first, edit never — until the user picks fixes in the closing menu.
The checks are `review-standards` and `review-security`; this skill replaces
their step 1 (scope), their triage step (edits) and their Output sections.

**Start at once: the first commands are `git status --short` and
`git branch --show-current`.** No `git fetch`, `pull` or `remote update` —
the user fetches before calling /review, the MR mode (1.2) aside; no diff
against `main`, `dev` or any other branch unless picked in a scope menu. No checkout, stash or switch. A
missing ref → name it in one line and stop.

## 1. Scope

| `$ARGUMENTS` | Scope |
|---|---|
| empty | steps 1–4 on `HEAD` |
| a path | steps 1–4, limited to that path |
| `<branch>`, the checked-out one too | steps 2–4 on local `<branch>`, else `origin/<branch>`; both exist and differ → the one containing the other, diverged → ask; not checked out and with a colleague's open MR → 1.2 |
| `mr` | pick among the open MRs — section 1.2 |
| `!<iid>` or an MR URL | that MR — section 1.2 |
| `audit <area>` | the area's current code — section 1.1 |

1. **Uncommitted.** `git status --short` not empty → the scope is
   `git diff HEAD` (staged and unstaged at once) plus every untracked file read
   whole; commits are not reviewed. This is the `git reset --soft <base>` flow:
   the whole branch sits staged on top of its base.
   - A merge in progress (`git rev-parse -q --verify MERGE_HEAD` succeeds) →
     `git diff HEAD` also carries everything the merged branch brings; skip
     it, no menu. Scope: the ticket commits of step 2 on `HEAD` (no key → none),
     plus the conflict resolution — files changed on both sides since
     `git merge-base HEAD MERGE_HEAD`, each read as `git diff HEAD -- <path>`
     and `git diff MERGE_HEAD -- <path>`. The resolution's own code is what
     matches neither side: a new line, or one side's change dropped.
2. **Ticket commits.** Clean tree → the ticket key: the branch name first
   (`feature/ABC-123-login` → `ABC-123`; format from project memory, else
   `[A-Z][A-Z0-9]+-[0-9]+`), then the top commit's subject. Walk
   `git log --first-parent --format='%h %p %s' -100 <ref>` down from the top:
   the run stops at the first commit carrying another key; its bottom is the
   oldest commit with the key. Keyless commits above the bottom belong to the
   run (review fixes).
   - No merge commit in the run → `git diff <bottom>^ <ref>`.
   - A merge in the run (the base merged in) → `git show <sha>` per non-merge
     commit of the run; judge each hunk against the file at `<ref>`, drop what
     a later commit already fixed.
3. **Base branch** — `<ref>` is `main`, `master`, `dev`, `develop` or the
   base from project memory: commits of many tasks sit there, so one
   `AskUserQuestion` before the pass. Key found → `Коммиты <KEY> (<n>:
   <oldest>..<newest>)` (Recommended), `Последний коммит <sha> <subject>`,
   `Аудит`, `Открытые MR (<n>)`. No key → the menu of step 4.
4. **Nothing** — clean tree, no commit with the key → one `AskUserQuestion`:

```
<Ключа задачи нет>. До какого коммита смотреть? В «Other» — sha, число коммитов или ветка.
- Последний коммит <sha> <subject> (Recommended)
- Коммиты от <base> (<n>)
- Аудит
- Открытые MR (<n>)
```

- `Открытые MR` only when the list call of 1.2 answered, with `<n>` ≥ 1.
- `Коммиты от <base>` only off a base branch and with `<n>` ≥ 1 — then it
  goes first as Recommended: `<base>` through
  [../shared/project-facts.md](../shared/project-facts.md) over local refs,
  `git diff <base>...<ref>`.
- «Other»: a sha → `git diff <sha>^ <ref>`, that commit included; a number N →
  the last N commits; a branch → the `<branch>` row. A merge inside → the
  per-commit rule of step 2.
- Header line before the pass, so a wrong pick is caught at once: mode
  (`незакоммиченные` / `мерж <sha>` / `коммиты <KEY>` / `последние <n>` /
  `от <base>` / `аудит <area>`), files
  and `+/-` totals, the reviewed commits as `--oneline` or `коммиты не смотрел`.
- Ref other than `HEAD`: read files as `git show <ref>:<path>`, usages as
  `git grep -n <name> <ref>` — the ref a literal sha or branch, never `$var`.
  The tokensave graph holds the working tree, not the ref; bash-router refuses
  `git grep` over the working tree.
- Free words after the target are the focus: checked first, full pass still.

### 1.1 Audit

The area's files at `HEAD`, no diff; `Аудит` → a second question: three of
the repo's top-level areas and `Всё приложение`, the rest through «Other».
`review-security` in full, step 5 on every entry point; the `review-standards` checklist, no regression pass. Whole app → auth,
payments, upload, webhooks, outbound calls, config first; report per module.

### 1.2 Open MRs

Colleagues' MRs only. List, pick, scope and drafts through the GitLab API:
[reference/gitlab.md](reference/gitlab.md), read before the first call. The
scope is the MR's diff after `git fetch` — the only fetch /review runs; no
checkout, no typecheck or tests, they go to the not-checked line. Several MRs
run one by one: report → drafts → next; after a large one (section 2) the
rest go to a fresh session through `handoff`, `Дальше` naming this file and
the remaining `!<iid>` — the new session continues on its own.

## 2. Pass

[../shared/review-pass.md](../shared/review-pass.md) in full — the same pass a
commit runs; a fact it leaves open goes to the not-checked line.

- Inventory first: `git diff --stat <range>` minus review-pass step 5 files,
  `*.scss`, `*.css`, `*.svg`. Each file is read in its diff before the report;
  an unread one goes to the coverage line. Past ~1500 changed lines it is
  large: one per session, `handoff` carries the unread files.
- A colleague's branch or MR with an open MR: its comments before the pass —
  *Existing comments* of [reference/gitlab.md](reference/gitlab.md).

No edits of any kind — not even a certain one-line fix or an impact-map line —
and no files written, `/tmp` included: a large diff is read as `--stat`, then
`git diff <range> -- <path>` per file, never redirected; the report goes to
chat, not to a file. Target `HEAD`: the project's typecheck and linter — a
script that writes (`--fix`, `--write`) runs as its bare tool without the
flag — then only the test files the scope adds or changes. Another ref: list
them in the not-checked line.

## 3. Report and menu

The report goes to chat as plain markdown: findings numbered, Critical →
Important → Minor, merged across both skills (one finding per defect, not per
skill), each with problem, manual check steps, current code and fix; then the
summary and the closing menu. Shapes, MR comments and menu:
[reference/report.md](reference/report.md); read it before the first finding.

The branch is the user's when every reviewed commit is authored by
`git config user.email`. Uncommitted scope: the commits of
`git log HEAD..@{u}` — what a soft reset took off; none, or no upstream →
the user's. Audit → the user's. Anything else is a colleague's.
MR mode (1.2): the report, then draft notes, no menu.
