---
name: hooks-guards
description: "How the local hook system behaves — security-guard, ask-guard, skill-gate, the shell guard, background ragsave sync, project-bootstrap — and how to react when one blocks or warns. Load when a hook refuses or warns, when ask mode, a guard, a permission prompt or a secret file is in question, when background indexing or project bootstrap comes up, or before reporting a tooling failure."
---

# Hooks and guards

CLAUDE.md already says never route around a refusal. This names which hook
fired and what it wants instead.

## security-guard

- Hard-blocks reading secret stores: `.env*`, `.envrc`, keys, certificates,
  `secrets.yaml`, Terraform state and `*.tfvars`, `/proc/*/environ`,
  `auth.json`, CLI credentials (`~/.claude/.credentials.json`, `~/.aws`,
  `~/.docker`, `~/.kube`, `gh`, `glab-cli`), also through `< file`, a `Grep` glob (`.env*`), a symlink to
  one, the browser (`file://`, `browser_file_upload`), and a recursive `grep`
  without `--include` — it reads `.env` in the tree; in an indexed project
  look the symbol up with `tokensave_search`, elsewhere add `--include=*.ts`. Take a
  variable's shape from `.env.example`, its value from the user.
- Asks confirmation: database dumps, non-local databases, pushes to protected
  branches, force push (`-f`, `+refspec`), branch deletion, push to the
  current branch (no refspec, `HEAD`, `@`, a `$…` name), deploy, remote-host commands,
  outbound data.
- Asks before editing `~/harness` (guards, hooks, rules, settings) from a
  session rooted elsewhere — say why the edit is needed, don't retry around it.
- OpenCode runs it from the plugin: only the hard block applies there, the
  confirmations come from `permission.bash`.
- Judges command **form**. Code *meaning* (auth, payments, secrets, outbound
  calls) still needs `review-security`.

## ask-guard

- In ask mode: blocks edits, mutating commands, publishing. Reads, search and
  tests stay; an edit is shown as a diff. Wrappers don't hide a write:
  `bash -c`, `eval`, `find -exec`, `( … )`, `&`, `prettier --write`,
  `git branch -D` are refused too; only a command that itself runs
  `ask-mode.mjs` passes.
- Ask mode is on only if the statusline says so or
  `node ~/.ai-hooks/bin/ask-mode.mjs status` says so. A refusal that doesn't
  mention ask mode has another source — name it; don't prescribe `/ask-off`.
- State is bound to the session root (`CLAUDE_PROJECT_DIR`), not the cwd.
  `ask-mode.mjs status` prints the anchor it used.

## skill-gate

- Denies an edit of a SKILL.md, `skills/*/reference/*.md`, `commands/*.md` or
  any `CLAUDE.md` until `skill-authoring` is loaded in this session, and a
  `git commit` until `review-standards`, `review-security` and `git-flow` are.
- The refusal names the missing skill: load it with `Skill(<name>)`, do what
  it says (the review skills mean running the checklist on the diff, not just
  loading), then repeat the call. Loaded-state is per session — after `/clear`
  the skills are gone from your context and from the gate alike.
- A prompt the user started with `/<skill>` counts as loaded.

## Shell guard

- `bash-router` denies reading or writing an existing file through the shell
  (`cat`, `head`, `sed -i`, `tee`, `> file`, `node -e`/`python -c` with a path,
  a heredoc into an interpreter) and asks for `Read`/`Edit`/`Write` instead.
  Same rule for `mcp__ide__executeCode`. Output clipping is `output-clip`.
- `node <file>` (`python`, `bun`, `deno` alike) with no `-e`/`-p`/`-c` and no
  heredoc is a run, not a read: `node ~/.ai-hooks/bin/<script>.mjs` and the
  README's commands pass; the inline-code forms stay blocked.
- It splits commands like the security guard: `&`, `$(…)`, backticks,
  `( … )`, `then`, `sudo -u x`, `xargs` don't hide a `cat`, and a heredoc body
  stays with its `node`/`python`. `grep`/`rg` and pipes reading stdin pass.
- `grep`/`rg`/`ag` over indexed code is refused by tokensave's own
  `hook-pre-tool-use`, which prints how to switch itself off. That switch
  (`TOKENSAVE_DISABLE_GREP_HOOK` anywhere in the command) and `git grep` inside
  an indexed project are denied by `bash-router`: a refusal is final — use
  `tokensave_search`/`signature_search`, `callers`, or `search` with
  `literal: true` for text.

## Background hooks

- `ragsave-sync` syncs an **existing** ragsave index on Stop; tokensave
  refreshes its own index from the MCP server. Creating an index is the
  user's call — say `tokensave init <path>` is needed, don't offer to run it.
- MCP servers start through `~/.ai-hooks/bin/mcp-serve.sh`, pinned to the
  session directory. Outside a project the server doesn't come up — tools are
  absent, not wrong.
- `links-context` (PostToolUse on read/edit tools, native and tokensave)
  injects a domain file of the project's impact map when the touched path
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
   `slow`, `crash`) with `sid`, `target`, `ms`; allowed calls are not written.
   The per-session trace of "what blocked, what came next".
2. `~/.ai-hooks/logs/errors.log` — background task failures and hook crashes
   (`exit=crash`); first read on any ragsave report. Marks live in
   `~/.claude/state/`.
3. Design docs: `~/.ai-hooks/README.md`, `~/.rag-mcp/README.md`. Tests:
   `~/.ai-hooks/test/test-*.mjs` — run after any edit under `~/.ai-hooks`; red
   → roll back, don't patch further.
4. Everything under `~/.claude/` is a symlink into `~/harness/claude/`;
   Edit/Write refuse symlinks — address the target path.
5. Deeper diagnosis is `/doctor` — offer it in one line, don't improvise.
