# Repairs after install

## Settings overwritten by tokensave

`installed_agents` in `~/.tokensave/state.toml` makes `tokensave init` and any
command after an upgrade rerun `install`, writing through the symlink into
`~/harness/claude/settings.json`. Restore without asking, never via
`tokensave uninstall` (it strips the harness's own tokensave hooks):

1. `git -C ~/harness diff claude/settings.json`: all hunks tokensave's
   (`tokensave hook-*` entries and their `matcher`, `mcp__tokensave__*`, key
   order) → `checkout` the file; the user's lines mixed in → revert only
   tokensave's with `Edit`. `model` is not a change.
2. `~/harness/install.sh` — symlinks, MCP entry, rules file to `.bak-<date>`,
   `installed_agents = []`.
3. `install.sh --check` and `git status` clean; restored settings load in the
   next session — say so.

## Machine env

`./install.sh` moves setup lines (brew, conda, cargo) from the backed-up
`~/.bashrc` into `~/.config/harness/env`; `install.sh --check` names each
line of that file to drop, as `env:<line> — <reason>`.

1. `Read` the file. Remove with `Edit`, without asking: `дубль строки` (keep
   the first), `это уже ставит shell/bashrc`, a dead path whose tool is gone
   from the machine. A dead path to a tool that moved (brew under another
   prefix) → fix the path instead.
2. A comment `# Перенесено install.sh …` left with nothing under it goes too.
   Lines `--check` does not name stay — it reads only top-level setup lines.
3. A tool missing from PATH with no line anywhere → `grep -n <tool>
   ~/.bashrc.bak-*`; the line found goes into the env file, not into
   `shell/bashrc` — that one is shared by every machine.
4. Rerun `install.sh --check`; the env applies in a new terminal and a new
   session — say so.

## Old backups

`install.sh --check` names each `<name>.bak-<date>` older than 30 days beside
a harness target or in the VS Code folder, as `<path> — бэкап старше 30 дней`.

1. Per backup, one line on what it holds against the live target (`diff -r`
   with the target) — the difference is what deletion loses.
2. `.bashrc.bak-*`, `.gitconfig.bak-*`: a setup line or key missing from
   `~/.config/harness/env` / `~/.gitconfig.local` goes there first (machine
   env, step 3).
3. `AskUserQuestion`, `multiSelect`, one option per backup («Удалить все»
   first when more than four). `rm -r` only the chosen paths, after the answer.

## Projects without an index

`--check` names each git project with Claude sessions that lacks `.tokensave/`
or `.ragsave/rag.db`, as `<path> — нет индекса: <commands>`. Creating an index
is the user's call: `AskUserQuestion` per project — run the named commands
(recommended), turn ragsave off with an empty `.ragsave-disable` in the
project root, or leave it. Run the commands after the answer with
`run_in_background: true` — a large project takes minutes.
