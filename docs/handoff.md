# Передача работы — 2026-11-01

Проект: /home/enkeym/harness, ветка codex. Изменения не закоммичены и не отправлены.

Цель выполнена: общие skills и инструкции отвязаны от модели/клиента; условия загрузки уточнены без примеров запросов. Task-brief охватывает анализ и планирование, handoff — передачу и восстановление, стековые skills — также анализ/диагностику. Doctor ограничен состоянием harness.

Основные пути:
- rules/core.md:23 — навыки выбираются для каждой задачи; читаются только отсутствующие в текущем контексте или изменённые инструкции. После compaction/передачи восстанавливаются недостающие.
- skills/, codex/AGENTS.md, qwen/QWEN.md — универсальные процессы и согласованная маршрутизация.
- ai-hooks/bin/skill-context.mjs — общий обработчик: SessionStart получает раздел Skills and hooks из core.md, UserPromptSubmit — короткий Skill reminder (298 байт вместо 2605). Запросы не сохраняет, SKILL.md не загружает. Тексты остаются в core.md, файлового флага загрузки нет.
- codex/hooks.json, bin/qwen-install.mjs, qwen/settings.json — подключение обработчика; SessionStart также прогревает RAG и синхронизирует существующие индексы, Stop синхронизирует. Первичный init остаётся ручным.
- ai-hooks/bin/{ragsave,tokensave}-sync.sh — учтён QWEN_PROJECT_DIR перед CODEX_PROJECT_DIR при отсутствии аргумента.
- bin/mcp-sync.mjs:syncQwen — сохранение ссылок на переменные в env вместо подстановки локальных значений. PLAYWRIGHT_MCP_EXTENSION_TOKEN в tracked settings оставлен ссылкой, не значением.
- README.md, OVERVIEW.md, AGENTS.md, ai-hooks/README.md, docs/{codex,qwen}.md, docs/links/, mcp/servers.md, ragsave/README.md — общие возможности описаны для обоих клиентов.

Установка применена. Обе install.sh --check проверки проходят; Qwen timeout нормализован до 10 секунд. Через штатное меню /hooks доверены два новых Codex hooks; все шесть включены и trusted. Записи доверия вручную не редактировались.

Проверки:
- node --test --test-concurrency=1 ai-hooks/test/test-*.mjs: 68/68 после разделения контекста событий, полный лог /tmp/harness-output.H7VtlR. Новые ожидания сначала воспроизвели старое поведение. Оба installer --check проходят.
- Codex app-server: фактически получены completed для SessionStart и UserPromptSubmit с контекстом; проверка с локальным HTTP stub без обращения к модели.
- Штатные HookRegistry/HookRunner Qwen 0.26.4: успешно выполнены все шесть обработчиков.
- git diff --check, JSON, ссылки документации и check-impact-map.mjs проходят.

Ограничения: загрузку SKILL.md конкретной моделью эти проверки не доказывают. Открытые клиенты нужно перезапустить; Qwen перечитывает определения через /hooks.

Продолжение: git status --short и git diff --stat, затем новый запрос пользователя. Успешные проверки не повторять без изменений. Сохранять внешнее форматирование test-qwen.mjs и изменения vscode/. Коммит/push не запрошены. Восстановить недостающие инструкции rules/core.md, AGENTS.md и skills: handoff; при доработке — skill-authoring, task-brief, tokensave-routing, doctor, test-conventions.
