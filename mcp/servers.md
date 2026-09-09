# MCP-серверы

Регистрация MCP живёт в `~/.claude.json` вперемешку с историей проектов, поэтому
файл целиком в репозиторий не кладётся. Здесь — команды, которыми состав
серверов воспроизводится на новой машине.

## Что должно быть подключено

```
tokensave    /usr/local/bin/tokensave serve
ragsave      ~/.local/bin/ragsave serve
playwright   npx -y @playwright/mcp@latest --headless --browser chromium
```

## Как зарегистрировать

```bash
claude mcp add tokensave   -- /usr/local/bin/tokensave serve
claude mcp add ragsave     -- "$HOME/.local/bin/ragsave" serve
claude mcp add playwright  -- npx -y @playwright/mcp@latest --headless --browser chromium
```

Проверка: `claude mcp list` — все три должны отвечать `✔ Connected`.

`ragsave` подключится только после того, как собран venv:
`./install.sh --venv`. `tokensave` — сторонний бинарь, ставится отдельно (см.
`../README.md`).
