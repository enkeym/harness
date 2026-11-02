---
paths:
  - "bin/codex-install.mjs"
  - "bin/codex-context.mjs"
  - "ai-hooks/bin/context-policy.mjs"
  - "skills/handoff/SKILL.md"
  - "skills/task-brief/SKILL.md"
  - "bin/opencode-install.mjs"
  - "bin/opencode-observe.mjs"
  - "opencode/**"
  - "ai-hooks/test/test-opencode.mjs"
  - "bin/mcp-sync.mjs"
  - "mcp/servers.json"
  - "mcp/servers.md"
  - "ai-hooks/bin/project-init.sh"
  - "docs/codex.md"
  - "ai-hooks/test/test-codex.mjs"
  - "ai-hooks/bin/context-runner.mjs"
  - "ai-hooks/bin/skill-context.mjs"
  - "ai-hooks/test/test-skill-context.mjs"
  - "rules/core.md"
  - "codex/hooks.json"
---

## Каталоги и установка клиентов
- `skills/task-brief/SKILL.md` задаёт пути `.codex/plans/<task-id>.md` и `.opencode/plans/<task-id>.md` и очистку завершённой задачи; `opencode/model-routing.mjs:deepseekRouting` и `opencode/model-routing.mjs:deepseekRoutingPro` передают тот же контракт основной сессии DeepSeek. При изменении согласованно обновлять `docs/context-automation.md`, `docs/opencode.md` и `ai-hooks/test/test-opencode.mjs`.
- `session.execution.succeeded` → `opencode/handoff.mjs:escalateStalledSession` проверяет финальный маркер тупика в завершённом ответе основной Flash-сессии и вызывает существующий `registerHandoff` с `--route=pro`. Согласованно проверять `opencode/model-routing.mjs:deepseekRouting`, `ai-hooks/test/test-handoff.mjs` и нативный сценарий `ai-hooks/test/test-opencode.mjs`.
- `session.execution.succeeded/failed/interrupted`, `session.hook("compaction")` — `opencode/harness.js` запускает `opencode/observations.mjs:collectObservations`; `bin/opencode-observe.mjs` читает полные страницы OpenCode 2.2.5. Контракт `sessions/<id>.json` и границы покрытия описаны в `docs/opencode.md`, читает `skills/shared/optimization-observations.md`; проверять нативное выполнение и сохранение истории в `ai-hooks/test/test-opencode.mjs` и `ai-hooks/test/test-opencode-observations.mjs`.
- `harness-brief`, `harness-plan`, `harness-review` — `opencode/model-routing.mjs:configureDeepSeek` записывает модели, разрешения и нативные команды подагентов в установщике; `opencode/harness.js` передаёт инструкции делегирования основной сессии DeepSeek, отдельный вариант для Pro. `opencode/handoff.mjs:registerHandoff` генерирует сводку на Flash и выбирает модель продолжения по маркеру `HARNESS-ROUTE` и `resolveHandoffModel`. При смене имён или моделей согласованно обновлять `ai-hooks/test/test-opencode.mjs`, `ai-hooks/test/test-handoff.mjs` и `docs/opencode.md`.
- `/handoff` — `opencode/handoff.mjs:registerHandoff` регистрирует нативную команду через `opencode/harness.js`; выбор модели продолжения DeepSeek выполняет `opencode/model-routing.mjs:resolveHandoffModel` по маркеру `HARNESS-ROUTE: progress=advancing|stalled next=done|concrete|investigate` и аргументу `--route=pro|flash`; `opencode/handoff-rpc.mjs` связывает её уведомления с переключением сессии в `opencode/tui.js`. `opencode/package.json` экспортирует обе части, установщик связывает весь пакет и удаляет прежний файловый entrypoint и prompt-шаблон. Проверять создание и продолжение сессии, события RPC и повторный вызов в `ai-hooks/test/test-opencode.mjs`, переключение TUI и ошибки — в `ai-hooks/test/test-handoff.mjs`.
- `handoff:<sessionID>` — `opencode/handoff.mjs:registerHandoff` сохраняет ID продолжения, `opencode/observations.mjs:observationAPI` читает его в `handoff.targetID`. Перенос создаёт независимую сессию без `parentID`; потеря ключа скрывает связь при анализе расходов.
- `skills/handoff/SKILL.md` → `ai-hooks/bin/context-policy.mjs:handoffPrompt` → `bin/codex-context.mjs` и `opencode/harness.js`: единые инструкции сводки используются native compaction обоих клиентов; пороги согласуются установщиками, input-бюджетом OpenCode и runner. После изменения skill переустановить Codex и перезапустить сервис OpenCode (reload может удержать модуль); проверять `test-context-policy.mjs`, `test-context-runner.mjs`, `test-opencode.mjs` и `docs/context-automation.md`.
- `rules/core.md` → `ai-hooks/bin/skill-context.mjs`: раздел Skills and hooks становится контекстом SessionStart, Skill reminder — контекстом UserPromptSubmit в обеих интеграциях. При изменении заголовков или событий согласованно обновлять обработчик, `codex/hooks.json`, `bin/opencode-install.mjs` и проверки `test-skill-context.mjs`, `test-codex.mjs`, `test-opencode.mjs`.
- `harness-context` — `bin/codex-install.mjs:links` устанавливает команду на
  `ai-hooks/bin/context-runner.mjs`; `ai-hooks/test/test-codex.mjs` проверяет symlink.
  При переносе entrypoint согласованно менять установку и `docs/context-automation.md`.
- MCP registry: при изменении `mcp/servers.json` согласованно обновлять `bin/mcp-sync.mjs`, `mcp/servers.md` и установку через `bin/codex-install.mjs` и `bin/opencode-install.mjs`; `ai-hooks/test/test-codex.mjs` и `ai-hooks/test/test-opencode.mjs` проверяют регистрацию, сохранение сторонних настроек и проверку `--check` без записи.
- `OPENCODE_CONFIG_DIR` — `opencode/config.mjs:configDirectory` используется установщиком и MCP-синхронизацией; `docs/opencode.md` и `ai-hooks/test/test-opencode.mjs` закрепляют приоритет JSONC, сохранение настроек и `--check` без записи.
- `CODEX_HOME` — `bin/codex-install.mjs:codexHome` задаёт каталог установки; `ai-hooks/bin/project-init.sh:lock_dir` размещает блокировки в `$CODEX_HOME/state`, если не задан `AI_HOOKS_STATE_DIR`. `docs/codex.md` описывает этот контракт; `ai-hooks/test/test-codex.mjs` проверяет пользовательский каталог и отсутствие записей при `--check`. Согласованно обновлять установщик, блокировки, документацию и тест при изменении поведения.
