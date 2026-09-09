---
name: git-flow
description: How to branch, commit, push and describe work for Jira and GitLab in this setup — commit message style, the Jira Summary/Description block, when a merge request may be opened, and what stays with the human. Load before committing, branching, pushing, or writing any Jira or MR text.
---

# Branches, commits, Jira

You do this yourself. There is no commit agent to delegate to.

## Never sign the commit

**No `Co-Authored-By`, no "Generated with", no mention of an AI, model or tool —
in the commit message, the MR, or the Jira text. No exceptions.**

Commits go into a company repository where such a signature is against policy and
puts the user's job at risk. The author is the user; git takes that from local
`user.name` / `user.email`, so never pass `--author` and never touch `git config`.

## The branch carries the ticket

`feature/STR-620` — the ticket number in the branch name is the only place the
Jira link comes from. A branch named without it loses that link silently. No
ticket at all — `feature/<slug>`, and the Jira block is written without a number.

Branch off the branch the repo actually develops from: usually `dev`, not `main`.
No worktrees; the user switches branches often and expects a switch back to be free.

## Commit as soon as a unit is done

A plan task, a verified bounded edit, a green fix — commit right away, without
asking. Never commit unfinished work, red tests, files outside the task, or secrets.

Message style follows the repo, and the repo means **the user's own recent
commits** (`git log --author=<user> -12`), not the loudest style in `git log` —
teammates here write four different ways. Currently that is Conventional Commits
in English with a scope: `feat(geo-objects): import KML/KMZ layers into GoV2 rooms`.

- Header: Conventional, English, one line, ~72 chars.
- Body only when the change spans several independent areas — 2–5 bullets **in
  Russian, plain human language**: what and why, not a file list. One-purpose
  change needs no body.
- Multi-line messages via `git commit -F -`, never a chain of `-m`.

## Push and MR stay with the human

**Plain commits are local.** Push only when the user asks.

**Never open a merge request on your own.** Only on an explicit request ("открой
MR", "готово к ревью"). An MR that appears by itself reads to the team lead as
"this branch is ready" and gets merged half-finished — that is exactly the damage
being avoided here.

Same for merges, force pushes and anything touching a protected branch: confirm
first. security-guard will ask too, and its prompt is not a formality.

### Writing the MR, once asked

The GitLab token comes from `$GITLAB_TOKEN` in the environment. **Never print it,
never echo it, never read it out of `~/.git-credentials`** — security-guard blocks
that file precisely because its contents would stay in the transcript forever.
Use the variable, don't look inside it.

Variable not set → say so in one line and print the Jira block instead. That is a
normal outcome, not a failure; do not go looking for the token elsewhere.

Host and project path come from `git remote get-url origin`
(`https://git.stormapi.su/jungerschaft/web_groza.git` → host `git.stormapi.su`,
path `jungerschaft%2Fweb_groza`). Look for an existing open MR first
(`?source_branch=<branch>&state=opened`): found → `PUT` the updated description,
none → `POST` a new one with `target_branch` = the branch this one forked from.

Title is the Jira `Summary`, description is the Jira `Description`, last line
`Closes STR-620` when the branch names a ticket. Build the JSON body in a file
rather than inline — a multi-line Russian description breaks in shell quoting.
No labels, assignee, milestone or squash flags: those are the project's settings,
not yours. Report the result as `MR !<iid> создан: <url>` or `обновлён`.

## The Jira block

After every commit **in a work repository**, print a block for the user to paste
into the ticket. Build it from the branch's own commits — `git log <base>..HEAD`,
`git diff <base>...HEAD` where `<base>` is the branch this one actually forked
from — never from the whole repo history.

Personal repositories with no tickets and no Jira project behind them (`~/harness`
and the like) don't get a block — there is nothing to paste it into, and printing
one is noise.

First commit in the branch → full `Summary` and `Description`.
Later commits → `Summary` (repeated in full, generalised if it no longer covers
the branch) plus `Дополнить Description:` with what this commit added.

**Summary**: `STR-620 Feature: короткая суть` — ticket number, then type from the
branch prefix (`feature/`→`Feature:`, `fix|bugfix|hotfix/`→`Bugfix:`,
`refactor/`→`Refactor:`, `chore/`→`Chore:`), then the point in Russian. As the
branch grows the summary must describe the whole branch, so raise it a level
rather than gluing two headlines with "и".

**Description**: Russian, as if the user were telling a colleague what they
changed — past tense, no explicit "я". Name the actual modules and say why. One
purpose → 2–4 sentences; several → a short bullet list. Banned: "Данное
изменение…", "В рамках задачи…", "Реализована функциональность…", "Таким
образом", marketing wording, markdown headings inside the text. Don't invent
motivation the diff doesn't show.

Jira itself has no API access configured here (no token, no CLI), so this block
is copied into the ticket by hand — print it ready to paste, with no commentary
wrapped around it. The same text goes into the MR when the user asks for one.
If the user ever confirms a GitLab↔Jira DVCS integration (a **Development**
section inside the ticket), a `STR-620 #comment <text>` line in the commit body
would let Jira pick it up by itself; nobody in this repo's history uses that
syntax yet, so don't add it unprompted.
