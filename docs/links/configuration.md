---
paths:
  - "bin/codex-install.mjs"
  - "bin/codex-context.mjs"
  - "ai-hooks/bin/context-policy.mjs"
  - "skills/handoff/SKILL.md"
  - "skills/task-brief/SKILL.md"
  - "skills/review/**"
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
- `/review mr` → `skills/review/reference/mr-delegation.md`: ревью на выбранной пользователем модели, делегирование только по явному запросу. Согласованно обновлять `skills/review/SKILL.md`, `docs/opencode.md` и `ai-hooks/test/test-opencode.mjs`.
- `skills/task-brief/SKILL.md` задаёт пути `.codex/plans/<task-id>.md` и `.opencode/plans/<task-id>.md` и очистку завершённой задачи. Модель скиллом не определяется; при изменении согласованно обновлять `docs/context-automation.md` и `docs/opencode.md`.
- `session.execution.succeeded` → синхронизация индексов и сбор наблюдений в `opencode/harness.js`; автоматической эскалации на Pro нет. Проверять отсутствие перехода после старого маркера тупика в `ai-hooks/test/test-opencode.mjs`.
- `session.execution.succeeded/failed/interrupted`, `session.hook("compaction")` — `opencode/harness.js` запускает `opencode/observations.mjs:collectObservations`; `bin/opencode-observe.mjs` читает полные страницы OpenCode 2.2.5. Контракт `sessions/<id>.json` и границы покрытия описаны в `docs/opencode.md`, читает `skills/shared/optimization-observations.md`; проверять нативное выполнение и сохранение истории в `ai-hooks/test/test-opencode.mjs` и `ai-hooks/test/test-opencode-observations.mjs`.
- `opencode/model-routing.mjs:configureModelRouting` удаляет прежние команды/агентов `harness-brief`, `harness-plan`, `harness-review`, `harness-review-flash` и старые модельные привязки встроенных агентов. Глобальная модель и пользовательские агенты сохраняются. Согласованно проверять установщик, `ai-hooks/test/test-opencode.mjs` и `docs/opencode.md`.
- `/handoff` — `opencode/handoff.mjs:registerHandoff` регистрирует команду через `opencode/harness.js`; `resolveHandoffModel` сохраняет модель исходной сессии, кроме явного `--route=pro|flash` для DeepSeek. Старые маркеры удаляются без эскалации. `opencode/handoff-rpc.mjs` и `opencode/tui.js` связывают уведомления с переключением сессии. Проверять `ai-hooks/test/test-opencode.mjs` и `ai-hooks/test/test-handoff.mjs`.
- `handoff:<sessionID>` — `opencode/handoff.mjs:registerHandoff` сохраняет ID продолжения, `opencode/observations.mjs:observationAPI` читает его в `handoff.targetID`. Перенос создаёт независимую сессию без `parentID`; потеря ключа скрывает связь при анализе расходов.
- `handoff:<sessionID>` также хранит отпечаток контекста, параметров и правил, готовую сводку до успешной отправки и предыдущие ID продолжений. `opencode/observations.mjs:collectObservations` обходит явные продолжения; `opencode/cost-report.mjs` объединяет связанные сессии по уникальным сообщениям, не складывая нативные итоги. `bin/opencode-costs.mjs` обновляет дневной отчёт, пороги и ручные оценки качества; `opencode/harness.js` запускает отчёт и локальные предупреждения после сбора. Проверять `test-handoff.mjs`, `test-opencode-observations.mjs`, `test-opencode-cost-report.mjs` и нативный `test-opencode.mjs`.
- `opencode/cache-policy.mjs` ограничивает TTL незавершённых Handoff и список ID; `opencode/handoff.mjs` проверяет существование продолжения и принятие restore-запроса. `opencode/instructions.mjs:readInstructions` используется и ключом кеша, и hook контекста; `opencode/context-cache.mjs:deduplicateContext` сокращает только полные повторы внутри текущего запроса без состояния между сессиями. Проверять `test-handoff.mjs`, `test-opencode-context-cache.mjs`, `test-opencode-observations.mjs` и нативный `test-opencode.mjs`.
- `skills/handoff/SKILL.md` → `ai-hooks/bin/context-policy.mjs`: `handoffPrompt` используется `bin/codex-context.mjs`, а `readHandoffPrompt` перечитывает skill для Handoff и native compaction OpenCode. Пороги согласуются установщиками, input-бюджетом OpenCode и runner. После изменения skill переустановить Codex; OpenCode подхватывает текст без перезапуска после загрузки новой версии плагина. Проверять `test-context-policy.mjs`, `test-context-runner.mjs`, `test-opencode.mjs` и `docs/context-automation.md`.
- `rules/core.md` → `ai-hooks/bin/skill-context.mjs`: раздел Skills and hooks становится контекстом SessionStart, Skill reminder — контекстом UserPromptSubmit в обеих интеграциях. При изменении заголовков или событий согласованно обновлять обработчик, `codex/hooks.json`, `bin/opencode-install.mjs` и проверки `test-skill-context.mjs`, `test-codex.mjs`, `test-opencode.mjs`.
- `harness-context` — `bin/codex-install.mjs:links` устанавливает команду на
  `ai-hooks/bin/context-runner.mjs`; `ai-hooks/test/test-codex.mjs` проверяет symlink.
  При переносе entrypoint согласованно менять установку и `docs/context-automation.md`.
- MCP registry: при изменении `mcp/servers.json` согласованно обновлять `bin/mcp-sync.mjs`, `mcp/servers.md` и установку через `bin/codex-install.mjs` и `bin/opencode-install.mjs`; `ai-hooks/test/test-codex.mjs` и `ai-hooks/test/test-opencode.mjs` проверяют регистрацию, сохранение сторонних настроек и проверку `--check` без записи.
- `OPENCODE_CONFIG_DIR` — `opencode/config.mjs:configDirectory` используется установщиком и MCP-синхронизацией; `docs/opencode.md` и `ai-hooks/test/test-opencode.mjs` закрепляют приоритет JSONC, сохранение настроек и `--check` без записи.
- `CODEX_HOME` — `bin/codex-install.mjs:codexHome` задаёт каталог установки; `ai-hooks/bin/project-init.sh:lock_dir` размещает блокировки в `$CODEX_HOME/state`, если не задан `AI_HOOKS_STATE_DIR`. `docs/codex.md` описывает этот контракт; `ai-hooks/test/test-codex.mjs` проверяет пользовательский каталог и отсутствие записей при `--check`. Согласованно обновлять установщик, блокировки, документацию и тест при изменении поведения.
