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
  `~/.tokensave/state.toml` (по нему тихий reinstall после смены версии).
  Ловят `bin/mcp-sync.mjs --check`, `install.sh:machine_paths_check` и
  `install.sh:tokensave_install_check`; новый файл, который начнёт писать
  install, проверка не увидит.
- Шаблоны `local/*.example` ↔ `install.sh:LOCALS` ↔ кто их читает:
  `shell/bashrc`, `shell/bash_env` (`~/.config/harness/env`), `git/gitconfig`
  (`[include]` `~/.gitconfig.local`). Новая переменная машины — строка в
  шаблоне; переименовал файл — install создаёт один, shell ищет другой.
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
