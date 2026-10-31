---
paths:
  - "bin/codex-install.mjs"
  - "bin/mcp-sync.mjs"
  - "mcp/servers.json"
  - "mcp/servers.md"
  - "ai-hooks/bin/project-init.sh"
  - "docs/codex.md"
  - "ai-hooks/test/test-codex.mjs"
  - "ai-hooks/bin/context-runner.mjs"
---

## Каталоги Codex
- `harness-context` — `bin/codex-install.mjs:links` устанавливает команду на
  `ai-hooks/bin/context-runner.mjs`; `ai-hooks/test/test-codex.mjs` проверяет symlink.
  При переносе entrypoint согласованно менять установку и `docs/context-automation.md`.
- MCP registry: при изменении `mcp/servers.json` согласованно обновлять `bin/mcp-sync.mjs`, `mcp/servers.md` и установку через `bin/codex-install.mjs`; `ai-hooks/test/test-codex.mjs` проверяет регистрацию, сохранение сторонних серверов и идемпотентность `--check`.
- `CODEX_HOME` — `bin/codex-install.mjs:codexHome` задаёт каталог установки; `ai-hooks/bin/project-init.sh:lock_dir` размещает блокировки в `$CODEX_HOME/state`, если не задан `AI_HOOKS_STATE_DIR`. `docs/codex.md` описывает этот контракт; `ai-hooks/test/test-codex.mjs` проверяет пользовательский каталог и отсутствие записей при `--check`. Согласованно обновлять установщик, блокировки, документацию и тест при изменении поведения.
