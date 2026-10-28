---
name: hooks-guards
description: "How the local hooks behave — security-guard, ask-guard, skill-gate, question-guard, the shell guard, ragsave sync, project-bootstrap — and how to react to them. Load when a hook refuses or warns, when ask mode, a guard or background indexing is in question, or before reporting a tooling failure."
---

# Hooks and guards

Never route around a refusal (`rules/core.md`); this names the hook and what it wants.

## security-guard

- Hard-blocks reading secret stores: `.env*`, `.envrc`, keys, certificates,
  `secrets.yaml`, Terraform state and `*.tfvars`, `/proc/*/environ`,
  `auth.json`, CLI credentials (`~/.claude/.credentials.json`, `~/.aws`,
  `~/.docker`, `~/.kube`, `gh`, `glab-cli`), also through `< file`, `xargs -a`, `tar`, a git message file (`git commit|tag|notes|merge -F .env`, `git commit -t .env`, `git config -f .env`; a computed `-F "$f"` asks),
  `dotenv -p`, an interpreter (`python.exe`, `python3.12`, heredoc code), a `Grep` glob
  (`.env*`), a symlink to one, the browser (`file://`, `browser_file_upload`), a recursive
  `grep` without `--include`, or with one `.env` matches (`*`, `.*`), over a directory
  (files like `*.mjs` pass) — it reads `.env`; indexed project: `tokensave_search`, exact
  string with `literal: true` (tokensave's hook stops code grep even with `--include`);
  docs, configs, yml: `rag_search`; elsewhere add `--include=*.ts`. Take a variable's shape from `.env.example`, its value from the user.
- Asks only on what can't be undone: every push but `--dry-run` (its own reason for a
  protected branch, force `-f`/`+refspec`, deletion, the current branch: no refspec, `HEAD`,
  `@`, a `$…` name), DB dumps and non-local DBs, prod docker, `kubectl`, non-read `ssh`, outbound
  data (`scp`, `curl -X POST|sh`), publish/deploy, migrations, `git reset --hard`, `rm -rf` of
  `/ ~ . .git`, `sudo` (list: `ai-hooks/README.md`), a computed git path, `env`: name one variable;
  an edit outside the session's repo (harness via `~/.claude` too; not `/tmp`, memory, plans).
- An action named in the user's last own prompt (transcript, `origin.kind: human`; not a handoff plan or a menu answer) skips its ask until the next prompt: «запушь»/`push`, «МР»/`PR` (push + `gh pr`/`glab mr`), «удали», «откати», «задеплой», «накати миграцию», the other project's directory name; force and branch deletion need «форс»/«удали ветку».
  Negation, a question («запушил?»), ``` blocks, `>` quotes grant nothing; `rm -rf /`/`~`, secret output, `env`, ssh, sudo, outbound, `kubectl` always ask; `gh auth token` is denied. Ask anyway → let the dialog answer.
- `dispatch` answers `allow` to every call no check denied or asked, in every mode. Kept: `AskUserQuestion`,
  `ExitPlanMode` (the handoff window), `EnterPlanMode`, and any call in plan mode.
- Judges command **form**; code *meaning* (auth, payments, secrets, outbound calls) still needs `review-security`.

## ask-guard

- In ask mode: blocks edits, mutating commands, publishing. Reads, search and
  tests stay; an edit is shown as a diff. Wrappers don't hide a write:
  `bash -c`, `eval`, `( … )`, `&`, `perl -pi`, a heredoc into `python`, `ed`/`vim -es`,
  `git pull`/`worktree add`, `tokensave_replace_lines`/`rename` (not a dry run) are
  refused too; only a command that itself runs `ask-mode.mjs` passes.
- Ask mode is on only if the statusline says so or
  `node ~/.ai-hooks/bin/ask-mode.mjs status` says so. A refusal that doesn't
  mention ask mode has another source — name it; don't prescribe `/ask-off`.
- State is bound to the session (`session_id`, `CLAUDE_CODE_SESSION_ID` in
  Bash): another session in the same directory has its own mode.
  `ask-mode.mjs status` prints the anchor it used. The ask mode reminder in
  an earlier turn is history — no reminder on the current prompt means off.

## skill-gate

- Denies an edit of a SKILL.md, `skills/*/reference/*.md`, `commands/*.md` or
  any `CLAUDE.md` (also via `cp`/`>`/`git checkout --`) until
  `skill-authoring` is loaded, and a commit (`commit`, `commit-tree`, `am`,
  `merge -m`, `--continue`) until `review-dispatch`, `review-standards`,
  `review-security`, `git-flow` are, while its line 2 is non-empty (empty
  it, no amend), or while no content `git diff` (not `--stat`) ran in its own
  call after the last edit and the `review-standards` load.
- `review-dispatch` loads first; verdict *plan* = the review pass inside plan mode, the gate checks the load and the `git diff` read only.
- The refusal names the missing skill or step: `Skill(<name>)`, repeat the
  call. Loaded-state is per session — after `/clear` it is gone from the gate
  and from your context alike. A prompt the user started with `/<skill>` counts.

## Read router

- `read-router` denies `Read` of a file in the tokensave index (table `files`): symbol →
  `tokensave_body`/`signature`, file or range → `tokensave_read` (`mode: "lines"` plus
  `lines: "A-B"`; `lines` alone returns the whole file), overview → `tokensave_context`;
  another project's file → `graph_root: "<its root>"` on each call. New files, `README`,
  configs outside the index, agent config paths and a session outside a project pass.
  Its edits: `tokensave_str_replace` — `Edit` needs a `Read` first.
- tokensave errored or answered empty → quote the answer and repeat the same
  `Read`: a repeat of the same target within 3 minutes passes (breaker, `~/.claude/state/guard-breaker.json`). Don't reach for the shell instead.

## question-guard

- Stop hook blocks once a turn without `AskUserQuestion`/`ExitPlanMode`: HAND once,
  also right after another Stop hook's block, HARD every turn (do what the meter's text says); last paragraph asking in text (`?`, "Дайте знать", "Варианты:"; rhetorical → rewrite; an offer of more work or a wait for an outside action → menu option or drop it; a line mentioning UAC is not judged for a wait), or open questions stated in the last two paragraphs ("Открытыми остаются вопросы: …").
- `plan-guard` denies `ExitPlanMode` on a plan past `AI_HOOKS_PLAN_LIMIT` or with a stacked snapshot: rewrite the plan file per `handoff`, then exit again.
- `model-hint` (PostToolUseFailure on Bash): one check (tsc, test, linter) failed a third time in a row with edits between, on Sonnet, once per session — no fourth guess: two lines on what fails and what was tried, then `AskUserQuestion` «Переключиться на Opus» (user runs `/model opus`) first.
- `resume-hint` on resume: work moved through handoff to the named session — changes after the handoff are its, not unknown; user writes here → repeat its `/resume <id>` in one line.
- `handoff-mark` (approved `ExitPlanMode` snapshot) → `handoff-pickup` (SessionStart `startup|clear`, same repo, ≤12 h) gives
  it to the new session once: «продолжи» after `/clear` suffices; a prompt in the marking session (`handoff-drop`) clears the mark.

## Shell guard

- `bash-router` denies reading or writing an existing file through the shell (`cat`/`sort`/
  `base64`, `sed -n`/`awk`/`grep ''`/`grep -v` with a file, `diff /dev/null`, `git show
  HEAD:<file>`, `sed -i`, `tee`, `> file`, `cp`/`mv` into `/tmp` or over a file, `vim -es`/`ed`,
  `node -e`/`python -c` with a path, a heredoc into an interpreter) and names the tool that
  passes; `mcp__ide__executeCode` too. Pass: `jq` over a `.json`/`.jsonl`/`.ndjson` outside the
  index, `>`/`>>` into `/tmp/` outside a project and `cat`/`tail` of it, `git show <other
  rev>:<file>`, `node <file>` (`python.exe`, `tsx` alike) without `-e`/`-p`/`-c`/heredoc (a
  run). Clipping: `output-clip`.
- It splits commands like the security guard: `&`, `$(…)`, backticks, `( … )`, `then`,
  `sudo -u x`, `xargs`, `bash -c`/`eval` don't hide a `cat`, and a heredoc body stays with
  its `node`/`python`; a literal `cd` in the chain moves the base for later segments and `*`/`?` in the last path component expands. `grep`/`rg` with a pattern and pipes reading stdin pass.
- `grep`/`rg`/`ag` over indexed code is refused by tokensave's own `hook-pre-tool-use`; its off
  switch (`TOKENSAVE_DISABLE_GREP_HOOK`) and `git grep` over the working tree are denied by
  `bash-router` — tokensave answers. `git grep … <sha|branch>` off HEAD passes, `$var` doesn't.
- `cd`/`pushd` into `~/.claude/projects` is denied: its `-home-…` names, reached relatively or
  by a glob, read as options. Write `~/.claude/projects/*/<sid>.jsonl` without `cd`.
- `scratch` deletes at turn and session end each `/tmp` path a `Bash`/`Write` call named before
  it existed (directories only if empty): don't clean up; what must outlive the turn → elsewhere.

## Background hooks

- `ragsave-sync` syncs an **existing** ragsave index at session start and turn
  end unless the repo root has `.ragsave-disable` (`rag_status`: `autosync`,
  `last_sync`), niced, 6 ONNX threads; at session start it first runs `ragsave warm`
  (model daemon up and loaded, not niced); tokensave syncs itself. An index is the user's call — say
  `tokensave init <path>` or `ragsave init` is needed, don't run it; `bin/project-init.sh` builds the other.
- MCP servers start through `~/.ai-hooks/bin/mcp-serve.sh`, pinned to the session
  directory. Outside a project the server doesn't come up — tools are absent, not wrong.
- `links-context` (PostToolUse on edit tools, native and tokensave; reads stay silent) injects
  the impact-map items naming the edited file, its directory or a glob over it (path in the
  domain's `paths:`), each once per session, plus "N more items"; none → one pointer line.
  Check the edit against them, add the missing link there. A slice only: the impact pass
  before the commit reads the whole domain and `INDEX.md` (a domain without `paths:`).
- `project-bootstrap` reports husky and CI weekly, a missing `CLAUDE.md` and impact map once per
  indexed project, never again: name it as a fact in the first reply (`/impact-map` for the map).
  Silent hook = deliberate skip (`<project>/.claude/bootstrap-ignore`).

## When something is broken

1. `~/.ai-hooks/logs/hooks.jsonl` — one line per check decision (`deny`, `ask`, `block`, `hint`, `slow`,
   `crash`) with `sid`, `target`, `ms`; allowed calls are not written. The per-session trace of
   "what blocked, what came next"; `slow` of `claude/dispatch.mjs` (one process per event) names `dispatch`.
2. `~/.ai-hooks/logs/errors.log` — background task failures and hook crashes
   (`exit=crash`); first read on any ragsave report. Marks live in `~/.claude/state/`.
3. Design docs: `~/.ai-hooks/README.md`, `~/.rag-mcp/README.md`. Tests:
   `~/.ai-hooks/test/test-*.mjs` — run after any edit under `~/.ai-hooks`; red
   → roll back, don't patch further.
4. `~/.claude/*` are symlinks into `~/.config/harness/repo/claude/`; Edit/Write refuse them — edit the target.
5. Deeper diagnosis is `/doctor` — name it as a fact, don't improvise.
