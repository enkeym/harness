# OpenCode: оптимизация, 2026-11-02

Проект `/home/enkeym/harness`, ветка `codex`. Клиент Codex; изменяли OpenCode 2.2.5. Пользователь разрешил все предложенные оптимизации. Работа завершена; последний запрос `$handoff`. Завершённые задачи не возобновлять. Коммит/push и перезапуск OpenCode не выполнялись. Старый handoff упоминал прежнее разрешение commit/push; текущий запрос требует только заметку.

Правила: `~/.config/harness/repo/rules/core.md`, проектный AGENTS.md. Навыки `~/.agents/skills/{handoff,optimize,task-brief,tokensave-routing,doctor,test-conventions,skill-authoring}/SKILL.md`; ссылки `skills/shared/optimization-observations.md`, `skills/shared/impact-map.md`. Читать недостающие инструкции; код через MCP. Комментарии не добавлять, агентов не запускать. Сохранить чужие изменения, особенно `rules/core.md`, `mcp/servers.md`, `vscode/settings.json`.

Готово:
- `opencode/handoff.mjs`, `cache-policy.mjs`: проверка продолжения, восстановление удалённого ID, проверка принятого restore-запроса. Неоднозначная доставка останавливает повтор. TTL незавершённой сводки 24 ч, previousIDs ≤32; собранные связи учёта сохраняются в observations. HANDOFF.md по TTL не удаляется.
- `opencode/instructions.mjs`, `harness.js`, `ai-hooks/bin/context-policy.mjs`: живое чтение core/AGENTS/handoff skill; одна копия собственных системных инструкций.
- `opencode/context-cache.mjs`: полные идентичные MCP-чтения/skills ≥512 байт заменяются ссылкой только внутри текущего запроса с полной копией. История и выполнение инструментов не меняются; после compaction старого digest недостаточно. Общего кеша ответов модели/shell нет.
- `opencode/model-routing.mjs`, `skills/review/SKILL.md`, `skills/review/reference/mr-delegation.md`: простое планирование/ревью напрямую; отдельный ревьюер для рисков при разрешении; повторная проверка исправлений и затронутых контрактов. Переиспользование проверок — инструкция с fingerprint входов и полным логом, не автоматический shell-кеш.
- Ранее добавлены cost-report/cost-policy/local-state, bin/opencode-costs.mjs и opencode-offpeak.mjs, сбор observations; Flash high для основных агентов, low explore, none title. Пользовательские ¥21.29 / 1383 запроса / 79889099 токенов не сверены с биллингом; экономия неизвестна.

Проверки: 121/121, `/tmp/harness-output.9LLJnl`; OpenCode installer --check `/tmp/harness-output.2OIcm2`, Codex `/tmp/harness-output.ghzrR5`; карта ссылок и diff --check успешны. Начальный сбой proxy-теста устранён изоляцией cwd в `ai-hooks/test/test-context-proxy.mjs`. Активных проверок/неясных записей нет. Отчёт: `~/.local/state/harness/optimize/opencode/90277afafe4bf1a0/cache-fixes-20261102.json` (600).

Далее: пользователю перезапустить OpenCode после активной работы; принудительно не перезапускать. Читать `docs/opencode.md:43-63`, `docs/links/configuration.md:27-36`. Отчёт: `node bin/opencode-costs.mjs report`. Успешные проверки без изменений не повторять. Ручной handoff в Codex текущий диалог не переключает.
