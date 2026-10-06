---
name: review-standards
description: "Cross-stack TypeScript review checklist and the procedure to run it on a diff — types (no any, one representation per value set, derived not copied), constants (no magic values, existing enum/config reused), reuse of existing code and installed libraries, naming that matches neighbours, styles only through project tokens, duplication, error handling, leftovers. Load on the diff before every commit and whenever asked to review code, a branch, an MR or someone else's change. Finds what the linter cannot."
---

# Standards review

The project's own code is the standard. Its linter, its formatter and `tsc`
are run, not re-done by hand; a finding is what they cannot see.

## Procedure

1. Read the whole diff before judging a line — every file in `--stat`,
   client, tests and generated specs (`swagger.json`) included; a large diff
   is read in chunks, never sampled, and a context warning does not shorten
   it. Uncommitted: `git diff HEAD` + `git status --short`. Branch:
   `git diff <base>...HEAD`.
2. Verify by search, never by eye: a literal → search the value in the project;
   a new type → search its fields; a new helper, hook or component → the reuse
   order of `code-rules.md` (project, installed packages, then a library
   proposal); a new dependency → was an installed one enough.
   Tests in the diff: do they assert behaviour or the mock? Run when in doubt.
3. Impact pass on **every** symbol whose behaviour the diff changes, not only
   on changed signatures — a caller compiles fine against a function that now
   returns filtered data. `tokensave_impact` / `callers` / literal `search`, plus
   the project's [../shared/impact-map.md](../shared/impact-map.md) for links
   no call edge carries. Close each hit one of three ways: unaffected (one line
   saying why), fixed in this diff, or covered by a test that fails on the old
   behaviour. A link the map lacks → add its line in this commit. No graph
   (`.tokensave/` missing or stale) → grep the symbol name, say so in one line.
4. Trace every candidate bug through the code from the user's action to the
   failure — how the app actually logs out, reloads, calls the endpoint, what
   the client really sends. Confirmed → a finding; not traceable from the repo
   → a question to the author under ⚠️; refuted → dropped. Wrong code is not a
   bug until its trigger is reachable.
5. Fix inside the diff silently (one line in chat per fix). Pre-existing
   problems the diff touches → one line under *Minor*, never a widening refactor.
6. Machines last: `tsc --noEmit`, linter, tests of the touched module — real
   output. Red = no commit.

## Checklist

Every section of [../shared/code-rules.md](../shared/code-rules.md) — read it
now unless it is already in this session's context — plus the stack skill's
structural rules, every item of the project's own review section in its
`CLAUDE.md` / `AGENTS.md` (each closed as checked or a finding), and:

**Leftovers**
- No `console.log`, debug flags, commented code, ownerless `TODO`, unused
  imports/exports/params, files outside the task, unrequested lockfile/config edits.

**Not a finding:** formatting, import order, anything the project's linter or
formatter own;
taste without consequence; refactor beyond the task (one *Minor* line at most);
"could be more generic" with no need yet.

## Output

Before a commit: one line per fix, then the commit.

Requested review (someone's diff, branch, MR) — spec first, then quality, ≤40
lines, ≤5 lines of quoted code:

```
Spec: ✅ | ❌ — <what is missing / extra>
Quality: approved | changes requested

Critical:  <breaks behaviour, data or a caller — path:line — why — fix>
Important: <edge-case bug, broken caller, a test that tests nothing>
Minor:     <one line each>
⚠️ Cannot verify from diff: <requirement — where to look>
Read: <N>/<N> files; machines: <tsc, lint, tests — result or why not run>
```

Empty section = "нет". Never "в целом хорошо" instead of a verdict. `Read`
below N/N → no verdict and no offer to publish; finish reading first.
Severity follows the traced impact, not the section count — a small diff with
one real bug gets one line, not a filled template. The verdict stands when the
user asks back; it changes only on a new fact, named in the reply.

## Comments posted to an MR

A colleague reads them, not a model.

- First person, plain spoken Russian: "Я бы вынес проверку MX до транзакции —
  иначе она держит соединение, пока ждёт DNS". No bureaucratic phrasing
  ("рассогласование", "осуществляется", "в целях"), no telegraphic fragments
  joined by dashes and semicolons.
- One problem per comment: what breaks, a concrete example, what I suggest.
  Two or three short sentences.
- Cite only what the author can open: code in the MR, the repository, docs on
  the server. Never a local file of mine (`CLAUDE.md`, memory, a skill).
- Leave the review unsubmitted unless the user says to send it.