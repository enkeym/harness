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
  `~/.docker`, `~/.kube`, `gh`, `glab-cli`), also through `< file`, `xargs -a`, `tar`,
  `dotenv -p`, an interpreter (`python.exe`, `python3.12`, heredoc code), a `Grep` glob
  (`.env*`), a symlink to one, the browser (`file://`, `browser_file_upload`), a recursive
  `grep` without `--include`, or with one `.env` matches (`*`, `.*`), over a directory
  (files like `*.mjs` pass) — it reads `.env`; indexed project: `tokensave_search`, exact
  string with `literal: true` (tokensave's hook stops code grep even with `--include`);
  docs, configs, yml: `rag_search`; elsewhere add `--include=*.ts`. Take a variable's shape from `.env.example`, its value from the user.
- Asks confirmation: every commit (`commit-tree`, `am`, `merge -m`, `--continue` too),
  database dumps, non-local databases, pushes to protected branches, force push (`-f`,
  `+refspec`), branch deletion, push to the current branch (no refspec, `HEAD`, `@`, a
  `$…` name), deploy, remote-host commands, outbound data, the whole environment (`env`,
  `printenv`, `jq -n env`; the `{env}` key passes): name one variable.
- Asks before editing `~/harness` (guards, hooks, rules, settings) from a
  session rooted elsewhere — say why the edit is needed, don't retry around it.
- OpenCode runs it from the plugin: only the hard block applies there, the
  confirmations come from `permission.bash`.
- Judges command **form**. Code *meaning* (auth, payments, secrets, outbound
  calls) still needs `review-security`.

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
  `merge -m`, `--continue`) until `review-standards`, `review-security`,
  `git-flow` are, or while its message has a non-empty line 2 — empty it and
  repeat, no amend.
- The refusal names the missing skill: load it with `Skill(<name>)`, do what
  it says (the review skills mean running the checklist on the diff, not just
  loading), then repeat the call. Loaded-state is per session — after `/clear`
  the skills are gone from your context and from the gate alike.
- A prompt the user started with `/<skill>` counts as loaded.

## Read router

- `read-router` denies `Read` of a file in the tokensave index (table `files`): symbol →
  `tokensave_body`/`signature`, file or range → `tokensave_read` (`mode: "lines"` plus
  `lines: "A-B"`; `lines` alone returns the whole file), overview → `tokensave_context`;
  another project's file → `graph_root: "<its root>"` on each call. New files, `README`,
  configs outside the index, agent config paths and a session outside a project pass.
  Its edits: `tokensave_str_replace` — `Edit` needs a `Read` first.
- tokensave errored or answered empty → quote the answer and repeat the same
  `Read`: a repeat of the same target within 3 minutes passes (breaker,
  `~/.claude/state/guard-breaker.json`). Don't reach for the shell instead.

## question-guard

- Stop hook blocks once a turn without `AskUserQuestion`/`ExitPlanMode`: past
  the meter's threshold (do what its text says); after a repo edit or commit
  (next step through the menu; task closed → one-line result); last paragraph
  asking in text (`?`, "Дайте знать", "Варианты:"; rhetorical → rewrite it).
- `plan-guard` denies `ExitPlanMode` on a plan past `AI_HOOKS_PLAN_LIMIT` or with a
  stacked snapshot: rewrite the plan file per `handoff`, then exit again.

## Shell guard

- `bash-router` denies reading or writing an existing file through the shell
  (`cat`/`sort`/`base64`, `sed -n`/`awk`/`grep ''`/`grep -v` with a file, `diff
  /dev/null`, `git show HEAD:<file>`, `sed -i`, `tee`, `> file`, `cp`/`mv` into
  `/tmp` or over a file, `vim -es`/`ed`, `node -e`/`python -c` with a path, a
  heredoc into an interpreter) and names the tool that passes;
  `mcp__ide__executeCode` too. Pass: `jq` over a `.json`/`.jsonl`/`.ndjson`
  outside the index, `>`/`>>` into `/tmp/` outside a project and `cat`/`tail`
  of it, `git show <other rev>:<file>`, `node <file>` (`python.exe`, `tsx`
  alike) without `-e`/`-p`/`-c`/heredoc (a run). Clipping: `output-clip`.
- It splits commands like the security guard: `&`, `$(…)`, backticks, `( … )`, `then`,
  `sudo -u x`, `xargs`, `bash -c`/`eval` don't hide a `cat`, and a heredoc body stays with
  its `node`/`python`. `grep`/`rg` with a pattern and pipes reading stdin pass.
- `grep`/`rg`/`ag` over indexed code is refused by tokensave's own
  `hook-pre-tool-use`; its off switch (`TOKENSAVE_DISABLE_GREP_HOOK`) and `git
  grep` over the working tree are denied by `bash-router` — tokensave answers.
  `git grep … <sha|branch>` off HEAD (an MR head) passes; a `$var` ref doesn't.

## Background hooks

- `ragsave-sync` syncs an **existing** ragsave index at session start and turn
  end unless the repo root has `.ragsave-disable` (`rag_status`: `autosync`,
  `last_sync`); tokensave syncs itself. Creating an index is the user's call —
  say `tokensave init <path>` / `ragsave init` is needed, don't run either.
- MCP servers start through `~/.ai-hooks/bin/mcp-serve.sh`, pinned to the session
  directory. Outside a project the server doesn't come up — tools are absent, not wrong.
- `links-context` (PostToolUse on edit tools, native and tokensave; reads
  stay silent) injects a domain file of the project's impact map when the edited path
  matches its `paths:` — once per session per domain. Treat the text as the
  map's lines for this change: check them, add the missing link to that
  file. Silent ≠ no links: a domain without `paths:` is reached only through
  `INDEX.md`, so the impact pass still reads the index.
- `project-bootstrap` reports a missing project `CLAUDE.md`, husky, CI,
  dependabot, `.env.example`, or an impact map in an indexed project: offer
  in one line in the first reply (`/impact-map` for the map). Silent hook =
  deliberate skip (`<project>/.claude/bootstrap-ignore`).

## When something is broken

1. `~/.ai-hooks/logs/hooks.jsonl` — one line per hook decision (`deny`, `ask`,
   `block`, `slow`, `crash`) with `sid`, `target`, `ms`; allowed calls are not written.
   The per-session trace of "what blocked, what came next".
2. `~/.ai-hooks/logs/errors.log` — background task failures and hook crashes
   (`exit=crash`); first read on any ragsave report. Marks live in `~/.claude/state/`.
3. Design docs: `~/.ai-hooks/README.md`, `~/.rag-mcp/README.md`. Tests:
   `~/.ai-hooks/test/test-*.mjs` — run after any edit under `~/.ai-hooks`; red
   → roll back, don't patch further.
4. Everything under `~/.claude/` is a symlink into `~/harness/claude/`;
   Edit/Write refuse symlinks — address the target path.
5. Deeper diagnosis is `/doctor` — offer it in one line, don't improvise.
