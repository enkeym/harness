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
  (и venv, и `PYTHONPATH`, и модели);
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
  `vscode/keybindings.json` (`ctrl+alt+a`) зовёт
  `~/.ai-hooks/bin/ask-mode.mjs` через `!` Claude Code: переименуешь скрипт —
  сочетание молча сломается.
- Путь к бинарю tokensave в хуках `claude/settings.json` ↔
  `install.sh:tokensave_hook_check` и `tokensave doctor`: оба сверяют путь
  буквально. `tokensave install`/`reinstall` переписывают хуки своим путём.
- `tokensave install` ↔ файлы, которые он пишет поверх харнеса: MCP-запись
  `tokensave` в `~/.claude.json`, `~/.claude/rules/tokensave.md`, `installed_agents` в
  `~/.tokensave/state.toml` (по нему тихий reinstall после смены версии и на
  `tokensave init`), `claude/settings.json` — сквозь симлинк, правка видна только
  в `git status` харнеса.
  Ловят `bin/mcp-sync.mjs --check`, `install.sh:machine_paths_check` и
  `install.sh:tokensave_install_check`; чистят `./install.sh` (MCP, правила,
  агенты) и `git checkout` — settings.json, порядок в `/doctor`. Новый файл,
  который начнёт писать install, проверка не увидит.
- Шаблоны `local/*.example` ↔ `install.sh:LOCALS` ↔ кто их читает:
  `shell/bashrc`, `shell/bash_env` (`~/.config/harness/env`), `git/gitconfig`
  (`[include]` `~/.gitconfig.local`). Новая переменная машины — строка в
  шаблоне; переименовал файл — install создаёт один, shell ищет другой.
- `install.sh:bashrc_migrate` ↔ имя бэкапа `link_one` (`~/.bashrc.bak-$STAMP`)
  ↔ что ставит `shell/bashrc` сам (список `own`: nvm, pnpm, `~/.local/bin`).
  Сменил имя бэкапа — перенос молча не запустится; новая строка PATH в
  `shell/bashrc` без записи в `own` — старая её копия из бэкапа задвоится в env.
  Порядок: после `LOCALS`, иначе на новой машине env ещё нет.
- `install.sh:gitconfig_migrate` ↔ имя бэкапа `link_one` (`~/.gitconfig.bak-$STAMP`)
  ↔ `[include]` `~/.gitconfig.local` последним в `git/gitconfig`: только так
  перенесённое значение разработчика перекрывает общее. Сдвинешь `[include]`
  выше — общий файл перебьёт имя и хелпер; многозначный ключ
  (`credential.helper`) не перекрывается, а добавляется к общему.
  Порядок: после `LOCALS`, иначе на новой машине local ещё нет.
- `install.sh:env_check` ↔ `skills/doctor/reference/repair.md` (Machine env): doctor удаляет
  строки по тексту причины (`дубль строки`, `это уже ставит shell/bashrc`,
  `нет бинаря/файла/каталога`). Сменил формулировку — поправь раздел.
  `SETUP_RE` и `BASHRC_OWN` общие с `bashrc_migrate`: что перенесено, то и
  проверяется.
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
