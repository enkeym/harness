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
  `~/.ai-hooks` — пути хуков в `claude/settings.json`, импорт по `os.homedir()` в
  `opencode/plugin/tokensave-guard.js`, вызов `log-error.sh` в
  `ai-hooks/bin/ragsave-sync.sh`.
  Сменил цель в `install.sh` одну — хуки, MCP и фоновые синки падают молча.
- Пути без машины — `install.sh:machine_paths_check` ищет `/home/<имя>/` и
  `/Users/<имя>/` во всех источниках `LINKS`, кроме каталогов `test`, `tests`,
  `logs`. Путь в новом формате (`$USER`, `/root/`) или новый источник вне
  `LINKS` проверка не увидит; фикстура с чужим HOME вне `test/` — ложное ✗.
- Путь к бинарю tokensave в хуках `claude/settings.json` ↔
  `install.sh:tokensave_hook_check` и `tokensave doctor`: оба сверяют путь
  буквально. `tokensave install`/`reinstall` переписывают хуки своим путём.
- `tokensave install` ↔ файлы, которые он пишет поверх харнеса: MCP-запись
  `tokensave` в `~/.claude.json` и `opencode/opencode.json` (через симлинк —
  в репозиторий), `~/.claude/rules/tokensave.md`,
  `~/.config/opencode/tokensave.md`, `installed_agents` в
  `~/.tokensave/state.toml` (по нему тихий reinstall после смены версии).
  Ловят `bin/mcp-sync.mjs --check`, `install.sh:machine_paths_check` и
  `install.sh:tokensave_install_check`; новый файл, который начнёт писать
  install, проверка не увидит.
- Шаблоны `local/*.example` ↔ `install.sh:LOCALS` ↔ кто их читает:
  `shell/bashrc`, `shell/bash_env` (`~/.config/harness/env`), `git/gitconfig`
  (`[include]` `~/.gitconfig.local`). Новая переменная машины — строка в
  шаблоне; переименовал файл — install создаёт один, shell ищет другой.
- Голое имя команды в `mcp/servers.json` (`playwright-mcp`) ↔ PATH оболочки,
  из которой запущен `install.sh`: `bin/mcp-sync.mjs:resolveCommand` пишет
  Claude найденный путь, OpenCode — голое имя (его PATH тоже должен видеть
  nvm). Запуск без nvm в PATH — сервер пропущен с кодом 1; смена версии node —
  путь у Claude устарел до следующего `./install.sh`.
- `install.sh:externals` ↔ раскладка пакета `@playwright/mcp`: chromium
  сверяется через `node_modules/playwright/cli.js install --dry-run` внутри
  глобального пакета (ревизия та, что ждёт MCP). Пакет сменит раскладку —
  проверка выдаст ложное «не скачан»; та же команда — в README.
- `mcp/servers.json` → `ai-hooks/bin/mcp-serve.sh` (аргумент — имя сервера);
  раскладывает по агентам `bin/mcp-sync.mjs`. Новый сервер в JSON без ветки
  `case "$kind"` в `mcp-serve.sh` не стартует.
