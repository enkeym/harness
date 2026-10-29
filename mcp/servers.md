# MCP

servers.json — единый список stdio-серверов.
node bin/mcp-sync.mjs регистрирует их через Codex CLI.
node bin/mcp-sync.mjs --check сообщает расхождения без изменений.
Пути ~/ раскрываются относительно HOME; сторонние серверы не удаляются.
