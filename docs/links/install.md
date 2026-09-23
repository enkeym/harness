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
  `ai-hooks/bin/ragsave-sync.sh`; `~/.rag-mcp` — `RAGSAVE_HOME` в `bin/ragsave`;
  `~/.ai-hooks` — пути хуков в `claude/settings.json`, абсолютный импорт в
  `opencode/plugin/tokensave-guard.js`, вызов `log-error.sh` в
  `ai-hooks/bin/ragsave-sync.sh`.
  Сменил цель в `install.sh` одну — хуки, MCP и фоновые синки падают молча.
- Домашний каталог, зашитый в конфиги, — проверка `baked` в `install.sh` ↔
  абсолютные пути в `claude/settings.json` (`permissions.allow` не раскрывает
  `$HOME`) и `opencode/plugin/tokensave-guard.js`. Новый абсолютный путь вне этих
  файлов проверка не увидит.
- Голое имя команды в `mcp/servers.json` (`playwright-mcp`) ↔ PATH оболочки,
  из которой запущен `install.sh`: `bin/mcp-sync.mjs:resolveCommand` пишет
  Claude найденный путь, OpenCode — голое имя (его PATH тоже должен видеть
  nvm). Запуск без nvm в PATH — сервер пропущен с кодом 1; смена версии node —
  путь у Claude устарел до следующего `./install.sh`.
- `mcp/servers.json` → `ai-hooks/bin/mcp-serve.sh` (аргумент — имя сервера);
  раскладывает по агентам `bin/mcp-sync.mjs`. Новый сервер в JSON без ветки
  `case "$kind"` в `mcp-serve.sh` не стартует.
