---
paths:
  - "bin/codex-install.mjs"
  - "bin/qwen-install.mjs"
  - "bin/opencode-install.mjs"
  - "opencode/**"
  - "ai-hooks/test/test-opencode.mjs"
  - "bin/mcp-sync.mjs"
  - "mcp/servers.json"
  - "mcp/servers.md"
  - "ai-hooks/bin/project-init.sh"
  - "docs/codex.md"
  - "docs/qwen.md"
  - "ai-hooks/test/test-codex.mjs"
  - "ai-hooks/test/test-qwen.mjs"
  - "ai-hooks/bin/context-runner.mjs"
  - "ai-hooks/bin/skill-context.mjs"
  - "ai-hooks/test/test-skill-context.mjs"
  - "rules/core.md"
  - "codex/hooks.json"
---

## Каталоги и установка клиентов
- `rules/core.md` → `ai-hooks/bin/skill-context.mjs`: раздел Skills and hooks становится контекстом SessionStart, Skill reminder — контекстом UserPromptSubmit в обеих интеграциях. При изменении заголовков или событий согласованно обновлять обработчик, `codex/hooks.json`, `bin/qwen-install.mjs` и проверки `test-skill-context.mjs`, `test-codex.mjs`, `test-qwen.mjs`.
- `harness-context` — `bin/codex-install.mjs:links` устанавливает команду на
  `ai-hooks/bin/context-runner.mjs`; `ai-hooks/test/test-codex.mjs` проверяет symlink.
  При переносе entrypoint согласованно менять установку и `docs/context-automation.md`.
- MCP registry: при изменении `mcp/servers.json` согласованно обновлять `bin/mcp-sync.mjs`, `mcp/servers.md` и установку через `bin/codex-install.mjs` и `bin/qwen-install.mjs`; `ai-hooks/test/test-codex.mjs` и `ai-hooks/test/test-qwen.mjs` проверяют регистрацию, сохранение сторонних настроек и проверку `--check` без записи.
- `QWEN_HOME` — `bin/qwen-install.mjs:qwenHome` задаёт каталог инструкций, навыков и settings.json; `docs/qwen.md` описывает контракт, `ai-hooks/test/test-qwen.mjs` проверяет ссылки и сохранение пользовательских настроек.
- `OPENCODE_CONFIG_DIR` — `opencode/config.mjs:configDirectory` используется установщиком и MCP-синхронизацией. `opencode/qwen-import.mjs:importQwen` переносит `modelProviders.openai` и ссылки на приватные ключи; `docs/opencode.md` и `ai-hooks/test/test-opencode.mjs` закрепляют приоритет JSONC, сохранение настроек и `--check` без записи.
- `CODEX_HOME` — `bin/codex-install.mjs:codexHome` задаёт каталог установки; `ai-hooks/bin/project-init.sh:lock_dir` размещает блокировки в `$CODEX_HOME/state`, если не задан `AI_HOOKS_STATE_DIR`. `docs/codex.md` описывает этот контракт; `ai-hooks/test/test-codex.mjs` проверяет пользовательский каталог и отсутствие записей при `--check`. Согласованно обновлять установщик, блокировки, документацию и тест при изменении поведения.
