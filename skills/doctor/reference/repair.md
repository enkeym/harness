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
