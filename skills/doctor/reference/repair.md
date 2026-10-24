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
   the first), `это уже ставит харнесс`, a dead path whose tool is gone
   from the machine. A dead path to a tool that moved (brew under another
   prefix) → fix the path instead.
2. A comment `# Перенесено install.sh …` left with nothing under it goes too.
   Lines `--check` does not name stay — it reads only top-level setup lines.
3. A tool missing from PATH with no line anywhere → `grep -n <tool>
   ~/.bashrc.bak-*`; the line found goes into the env file, not into
   `shell/bashrc` or `shell/harness.bash` — those are shared by every machine.
4. Rerun `install.sh --check`; the env applies in a new terminal and a new
   session — say so.

## Configured machine

`./install.sh` on a machine set up before the harness moves `~/.claude/`
`settings.json`, `keybindings.json`, `CLAUDE.md`, `skills`, `commands` and
`~/.tokensave/config.toml` to `<target>.bak-<date>`, and lists what each held
beyond the harness under `<file> — своё, чего нет в харнессе (<src>):`;
`install.sh --check` lists the same from the live target before the move. The
report carries no values: read them from `<file>` yourself, and never print an
`env` value or a credential-like scalar in chat.

1. Per item, `AskUserQuestion` (up to four items per call): «Перенести в
   харнесс» / «Оставить в бэкапе». Recommend leaving an item that is a
   machine path, a tokensave entry (`tokensave hook-*`, `mcp__tokensave__*`)
   or a duplicate of what the harness already does under another name.
2. Carry each chosen item into `~/harness`:

| Report line | Carry over |
|---|---|
| `свой: <name>` under `skills` / `commands` | `Read` + `Write` each file into `skills/<name>/` / `claude/commands/<name>`; run the `skill-authoring` checklist, an auto-loaded skill gets its row in `rules/core.md` |
| `изменён: <name>` | `diff -r ~/harness/<src>/<name> <file>/<name>`; only the user's lines go into the harness file with `Edit`, the rest stays the harness's |
| `env.<NAME>` | a secret (token, key, password) → `export NAME=…` in `~/.config/harness/env`, never into git; otherwise `Edit` `env` in `claude/settings.json` |
| `permissions.<allow\|deny\|ask>: <rule>` | append to that array in `claude/settings.json`; a machine path in the rule → through `~` |
| `hooks.<event>[<matcher>]: <command>` | the entry under that event and matcher in `claude/settings.json`; a script it runs → `ai-hooks/` (`Read` + `Write`), called through its interpreter (`node ~/.ai-hooks/<script>`, `bash …`) — an absolute path fails `machine_paths_check` |
| `<key.path>`, `<key.path> — другое значение` | `Edit` the key in `claude/settings.json`; the question names both values unless the key holds a credential |
| `bindings[<context>].<key>` | `Edit` that block in `claude/keybindings.json` |
| `<file> — отличается от харнесса (<src>), строк своих: N` | `diff ~/harness/<src> <file>`, one question per own rule or setting; a `CLAUDE.md` rule goes where [claude-md.md](../../skill-authoring/reference/claude-md.md) places it, `config.toml` lines into `tokensave/config.toml` |
| `<file> не разобран как JSON — сравнить руками` | `Read` it, then the rows above by hand |
| `<file> — node не найден, …` | install node, rerun `install.sh --check` |
| `core.hooksPath = <dir> из … не перенесён` | `ls <dir>`; per hook a name tokensave does not use → `Read` + `Write` into `~/.config/git/hooks/` (machine-local), then `chmod +x`; the same name → leave and say so, `tokensave githooks on` rewrites its hooks |

3. `git -C ~/harness diff`, the test loop from step 1, then the commit
   trigger: `feat(skills)` for skills and commands, `chore(config)` for
   `claude/settings.json` and `claude/keybindings.json`. Settings and hooks
   load in the next session — say so.
4. The backup stays; its removal is the next section's question.

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
or `.ragsave/rag.db`, as `<path> — нет индекса: <command>`. Creating an index
is the user's call: `AskUserQuestion` per project — run the named command
(recommended), turn ragsave off with an empty `.ragsave-disable` in the
project root, or leave it. Run the command after the answer with
`run_in_background: true` — a large project takes minutes. One init is
enough: `project-init.sh` builds the other index in the background.
