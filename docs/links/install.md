---
paths:
  - "install.sh"
  - "bin/**"
  - "mcp/**"
---

# install — связи, которых граф не видит

## Контракты и доки
- Цели симлинков `install.sh` ↔ зашитые пути у потребителей:
  `~/.local/bin/ragsave` — запускают `ai-hooks/bin/mcp-serve.sh`,
  `ai-hooks/bin/ragsave-sync.sh`; `$RAG_HOME` — `RAGSAVE_HOME` в `bin/ragsave`
  (и venv, и `PYTHONPATH`, и модели) и `ragsave/ragsave/config.py:RAGSAVE_HOME`
  (модели и сокет демона);
  `~/.ai-hooks` — пути хуков в `claude/settings.json`, вызов `log-error.sh` в
  `ai-hooks/bin/ragsave-sync.sh`.
  Сменил цель в `install.sh` одну — хуки, MCP и фоновые синки падают молча.
- Пути без машины — `install.sh:machine_paths_check` ищет `/home/<имя>/` и
  `/Users/<имя>/` во всех источниках `LINKS` и в `vscode/`, кроме каталогов
  `test`, `tests`, `logs`. Путь в новом формате (`$USER`, `/root/`) или новый источник вне
  `LINKS` проверка не увидит; фикстура с чужим HOME вне `test/` — ложное ✗.
- `install.sh:VSCODE_LINKS` ↔ `%APPDATA%\Code\User` VS Code в Windows: цель
  симлинка читает `win_link_target` из вывода `dir /AL` (`<SYMLINK>`,
  `<SYMLINKD>`, путь в скобках). Сменится формат `dir` — `--check` выдаст
  ложное «не симлинк», а install пересоздаст живой симлинк.
  На macOS (`uname -s` = `Darwin`, WSL проверяется первым) `install.sh:vscode_dir` ↔
  `~/Library/Application Support/Code/User`, симлинки — `link_one`/`check_one`.
  VS Code сменит каталог — настройки молча не подключаются, `--check` о них не скажет.
  `vscode/keybindings.json` (`ctrl+alt+a`) зовёт
  `~/.ai-hooks/bin/ask-mode.mjs` через `!` Claude Code: переименуешь скрипт —
  сочетание молча сломается.
- Хуки tokensave в `claude/settings.json` — голое `tokensave` в exec-форме
  (`command` + `args`) ↔ `install.sh:tokensave_hook_check` и `tokensave doctor`.
  doctor принимает только exec-форму с именем `tokensave`: строку с аргументами
  он переписывает абсолютным путём, обёртку с другим именем не узнаёт и дописывает
  рядом свои хуки (проверено на песочном HOME) — оба раза сквозь симлинк в харнесс.
  `tokensave install`/`reinstall` переписывают хуки абсолютным путём —
  `tokensave_hook_check` сверяет его с PATH. Claude Code ищет имя в PATH своего
  процесса: без каталога tokensave в нём хуки молча не стартуют.
- `install.sh:tokensave_missing` ↔ ключи `last_installed_version` /
  `previous_version` в `~/.tokensave/state.toml`: переименует tokensave — версия
  молча пропадёт из подсказки.
- `tokensave install` ↔ файлы, которые он пишет поверх харнеса: MCP-запись
  `tokensave` в `~/.claude.json`, `~/.claude/rules/tokensave.md`, `installed_agents` в
  `~/.tokensave/state.toml` (по нему тихий reinstall после смены версии и на
  `tokensave init`), `claude/settings.json` — сквозь симлинк, правка видна только
  в `git status` харнеса.
  Ловят `bin/mcp-sync.mjs --check`, `install.sh:machine_paths_check` и
  `install.sh:tokensave_install_check`; чистят `./install.sh` (MCP, правила,
  агенты) и `git checkout` — settings.json, порядок в `/doctor`. Новый файл,
  который начнёт писать install, проверка не увидит.
- Ядро и личное: `install.sh:PERSONAL_LINKS`/`PERSONAL_LOCALS`/`PERSONAL_REPORTS`
  вливаются в `LINKS`/`LOCALS`/`REPORTS` только с `--personal` или меткой
  `~/.config/harness/personal` (её ждут `/doctor` с `install.sh --check` и тесты
  `test-install-check.mjs`, читающие оба массива). Без личного `bashrc_hook`
  дописывает в чужой `~/.bashrc` блок `# >>> harness >>>` ↔ тот же блок в
  `shell/bashrc` ↔ цель `~/.config/harness/bashrc` → `shell/harness.bash` в `LINKS`:
  сменил заголовок в одном месте — блок допишется второй раз или `shell_migrate`
  перенесёт его в env. Новая строка ядра — в `shell/harness.bash`, не в `shell/bashrc`.
- Шаблоны `local/*.example` ↔ `install.sh:LOCALS` ↔ кто их читает:
  `shell/harness.bash`, `shell/bash_env` (`~/.config/harness/env`; zsh — через `shell/zshenv`), `git/gitconfig`
  (`[include]` `~/.gitconfig.local`). Новая переменная машины — строка в
  шаблоне; переименовал файл — install создаёт один, shell ищет другой.
- `install.sh:shell_migrate` ↔ имена бэкапов `link_one` (`~/.bashrc.bak-$STAMP`,
  `~/.zshenv.bak-$STAMP`) ↔ что ставят `shell/bashrc`, `shell/harness.bash` и `shell/zshenv` сами (список
  `own`: `~/.local/bin` ядра, nvm и pnpm — только с личным; строка `brew shellenv` — дословной копией в `shell/zshenv`).
  Сменил имя бэкапа — перенос молча не запустится; новая строка PATH в
  `shell/bashrc` или `shell/zshenv` без записи в `own` — старая её копия из бэкапа
  задвоится в env. env читают и bash, и zsh: zsh-синтаксис из `.zshenv` в нём
  сломает bash.
  Порядок: после `LOCALS`, иначе на новой машине env ещё нет.
- `install.sh:wanted` ↔ цель `~/.zshenv` в `LINKS`: без `zsh` в PATH и без
  прежнего файла её не ставят ни install, ни `--check`. Переименуешь цель — проверка
  молча перестанет срабатывать, и `~/.zshenv` снова появится на машине без zsh.
- `install.sh:gitconfig_migrate` ↔ имя бэкапа `link_one` (`~/.gitconfig.bak-$STAMP`)
  ↔ `[include]` `~/.gitconfig.local` последним в `git/gitconfig`: только так
  перенесённое значение разработчика перекрывает общее. Сдвинешь `[include]`
  выше — общий файл перебьёт имя и хелпер; многозначный ключ
  (`credential.helper`) не перекрывается, а добавляется к общему.
  Порядок: после `LOCALS`, иначе на новой машине local ещё нет.
  `core.hooksPath` из бэкапа в local не идёт ↔ `core.hooksPath` в `git/gitconfig`
  ↔ проверка `post-checkout` в `install.sh:externals`: перекрытый local каталог
  хуков молча выключил бы git-хуки tokensave. `externals` проверяет файл, только
  если `core.hooksPath` — ровно `~/.config/git/hooks`, иначе молчит. Сменил каталог в
  `git/gitconfig` — поправь и `externals`, а прежнее значение с машины начнёт
  предупреждать; формулировка `не перенесён` ↔ repair.md (Configured machine).
  Ключ должен остаться в `git/gitconfig`: `tokensave githooks on` без него пишет
  абсолютный путь сквозь симлинк `~/.gitconfig` в репозиторий, а local не читает.
- Хелпера `store` в `git/gitconfig` нет ↔ пример `[credential "<хост>"]` в
  `local/gitconfig.local.example` ↔ предупреждение `credential.helper store не задан`
  в `install.sh:externals` (`--get-regexp` по `credential.*helper`, значение `store`).
  `shell/bash_env` читает `~/.git-credentials` сам, без git: без хелпера
  `GITLAB_TOKEN` есть, а push по https просит пароль.
- `install.sh:env_check` ↔ `skills/doctor/reference/repair.md` (Machine env): doctor удаляет
  строки по тексту причины (`дубль строки`, `это уже ставит харнесс`,
  `нет бинаря/файла/каталога`). Сменил формулировку — поправь раздел.
  `SETUP_RE` и `BASHRC_OWN` общие с `shell_migrate`: что перенесено, то и
  проверяется.
- `install.sh:REPORTS` ↔ цели `LINKS` и имена бэкапов `link_one` (`<цель>.bak-$STAMP`):
  `backup_report` сверяет бэкап этого запуска, в `--check` — живую цель-не-симлинк.
  Цель убрали из `LINKS`, а из `REPORTS` нет — отчёт молча пуст; новая цель
  со своим содержимым без строки в `REPORTS` уедет в бэкап без отчёта.
  `bin/claude-diff.mjs` ↔ форма `settings.json` (`env`, `hooks.<event>[].hooks[]`
  с `command`+`args`, `model`) и `keybindings.json` (`bindings[]` с `context`):
  Claude Code сменит форму — хук или привязка уйдут в отчёт целиком или пропадут.
  Формулировки (`свой:`, `изменён:`, `строк своих:`, `не разобран как JSON`,
  `env.<имя>`, `hooks.<event>[<matcher>]:`) ↔ repair.md (Configured machine).
- `install.sh:backups_check` ↔ формат `STAMP` (`%Y%m%d-…`) и каталоги, куда
  `.bak-` кладут `link_one`, `vscode_one` и чистка правил tokensave: дата берётся
  из имени. Сменил формат `STAMP` или бэкап лёг в новый каталог — старые молча
  пропадут из отчёта. Отсечка — `date -d` (GNU), иначе `date -v` (BSD, macOS);
  не сработали оба — отчёт молча пуст. Формулировки строк ↔ `skills/doctor/reference/repair.md`
  (Old backups).
- `install.sh:projects_check` ↔ поле `cwd` в транскриптах
  `~/.claude/projects/*/*.jsonl` ↔ `.ragsave-disable` у `ragsave-sync`.
  Claude Code переименует поле — проекты без индекса молча пропадут из отчёта.
  Формулировка `нет индекса:` ↔ repair.md (Projects without an index).
  Предупреждение `на диске Windows` — только для `cwd` вида `/mnt/<буква>/`:
  другой automount root в `/etc/wsl.conf` проверка не увидит.
- `install.sh:is_wsl` ↔ `WSL_DISTRO_NAME` или `/proc/sys/fs/binfmt_misc/WSLInterop[-late]`
  и `CMD_EXE` (`cmd.exe` из PATH, иначе `/mnt/c/Windows/System32`). Тесты
  `test-install-check.mjs` держат WSL выключенным только отсутствием `wslpath` в
  их PATH: добавишь его в `TOOLS` — тест install полезет mklink в настоящий VS Code.
- Голое имя команды в `mcp/servers.json` (`foo-mcp`) ↔ PATH оболочки,
  из которой запущен `install.sh`: `bin/mcp-sync.mjs:resolveCommand` пишет
  Claude найденный путь. Запуск без nvm в PATH — сервер пропущен с кодом 1; смена версии node —
  путь у Claude устарел до следующего `./install.sh`.
- `install.sh:externals` ↔ раскладка пакета `@playwright/mcp`: chromium
  сверяется через `node_modules/playwright/cli.js install --dry-run` внутри
  глобального пакета (ревизия та, что ждёт MCP). Пакет сменит раскладку —
  проверка выдаст ложное «не скачан»; та же команда — в README. Сам сервер
  в `mcp/servers.json` не входит: `claude mcp add -s local` в проекте (README).
  Синк local scope не видит — сменилась версия node, путь у
  Claude в проекте устарел, перерегистрировать руками.
- Фильтр `nomodel` — имя в `.gitattributes` ↔ `install.sh:git_filter` (`FILTER_CLEAN` в
  `.git/config`). Переименовал в одном месте или машина без `./install.sh` — git молча
  берёт файл как есть, и каждое `/model` снова висит в `git status`.
- `mcp/servers.json` → `ai-hooks/bin/mcp-serve.sh` (аргумент — имя сервера);
  регистрирует в Claude `bin/mcp-sync.mjs`. Новый сервер в JSON без ветки
  `case "$kind"` в `mcp-serve.sh` не стартует.
- `onnxruntime-gpu` в `ragsave/requirements.txt` ↔ `--no-deps` и `pip uninstall
  onnxruntime` в `install.sh:build_venv` ↔ зависимость fastembed от `onnxruntime`.
  Обе сборки пишут в один пакет: снял `--no-deps` — pip доставит CPU-сборку
  поверх, и `ragsave/ragsave/embedder.py:_use_cuda` не найдёт CUDA. Новая
  зависимость при `--no-deps` не подтянется сама — пин в `requirements.txt`.
  Без `nvidia-smi` `build_venv` правит список на лету: строки `nvidia-*` вон,
  `onnxruntime-gpu==X` → `onnxruntime==X`. Переименуют пакеты nvidia или
  разойдутся версии сборок — CPU-машина получит GPU-пакеты или ошибку pip.
  Чужую сборку `build_venv` находит в `pip list --format=freeze` и после её удаления
  ставит свою с `--force-reinstall`: обе делят каталог `onnxruntime/`. На CPU-пути
  тот же список даёт пакеты `nvidia-*` на удаление. Сменится формат `pip list` —
  чужая сборка останется, а `import onnxruntime` упадёт на venv с обеими.
- Проверка `sqlite3.Connection.enable_load_extension` в `install.sh:build_venv` ↔
  загрузка sqlite-vec в `ragsave/ragsave/store.py`. ragsave перейдёт на другой способ
  загрузки — проверка зря откажет python macOS; уберёшь проверку — venv на
  `/usr/bin/python3` соберётся, а ragsave упадёт на первом индексе.
