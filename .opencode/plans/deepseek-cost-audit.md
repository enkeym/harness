# DeepSeek Cost Audit — план и факты

Задача: аудит расходов DeepSeek + план оптимизации. Режим: только анализ, изменения — после согласования.
Ограничения: не менять файлы, не слать API-запросы, не раскрывать секреты.

## Проверенные факты (источники)

- OpenCode v2.2.6 (npm, Node 24.18.0), сервис 127.0.0.1:49374, лог ~/.local/share/opencode/log/opencode.log.
- Провайдер deepseek: @ai-sdk/openai, baseURL https://api.deepseek.com/v1, api:"chat" (OpenAI Chat Completions), ключ из файла keys/deepseek.
- Модели (цены USD/1M input/output/cacheRead): v4-pro 1.32/3.96/0.044; v4-pro-offpeak 0.66/1.98/0.022; flash 0.3/1.2/0.006; flash-offpeak 0.15/0.6/0.003. reasoningEffort default low; effort low/high/max. cacheWrite=0 (DeepSeek не возвращает write; запись бесплатна).
- model default: deepseek/deepseek-flash. compaction: auto=true, keep 20000, buffer 30000, background_compaction=false.
- Глобальный плагин harness (~/.config/opencode/plugins/harness): бюджеты (dailyNativeUSD default 5, сейчас null в ~/.config/harness/opencode-costs.json; dailyProviderCNY 25), cost-report (reports/YYYY-MM-DD.json/.md в ~/.local/state/harness/optimize/opencode/reports), model routing (offpeak алиасы, авто-downgrade Pro→Flash в build), loop guard (softReads 20/hardReads 40, inject digests, resume protocol), dedupContext (одинаковые tool results → ссылка), compaction hook (handoff prompt), brief/handoff/task-context, retrieval-routing (инструкции для read/grep/glob/execute), context hook (core.md+AGENTS.md ~15KB в каждый запрос), maxOutputTokens 8192, limit.input min(context, 150000), при бюджете maxTokens 2048.
- MCP: tokensave (--compact), ragsave, playwright (@playwright/mcp 0.0.83, --eager). Индексы локальные: .tokensave 12M, .ragsave 50M, embeddings локальные, внешних платных вызовов нет.
- 22 скилла on-demand; agents: ask (+встроенные build/plan/general/explore; hidden compaction/title/summary). web_groza: плагин ai-kit (project hook), своего opencode.json нет.

## Метрики (cost-report, recomputed по времени)

| День | Сообщений | Компактаций | USD | input | cacheRead | output+reasoning |
|---|---|---|---|---|---|---|
| 2026-11-03 | 2713 | 56 | 5.13 | 2.56 | 0.81 | 1.75 |
| 2026-11-04 | 2250 | 36 | 3.17 | 1.59 | 0.58 | 1.00 |
| 2026-11-05 | 2379 | 41 | 3.02 | 1.62 | 0.45 | 0.96 |
| 2026-11-06 | 1192 | 35 | 1.70 | 0.95 | 0.19 | 0.55 |

- Cache hit rate: 63–82% (в чистых build-сессиях до 92%).
- Компакции: 35/день, ~0.38 USD/день ≈ 22% расходов (avg 77k input/компакция, кэш-мисс).
- Reasoning: 60–211k токенов/день (0.04–0.25 USD); max-вариант в plan-сессиях (98k reasoning на 105 сообщений).
- Native-оценка OpenCode ≈ 2× пересчёта (считает по peak-тарифу; реально запросы в off-peak).
- Ретраи/ошибки API DeepSeek: ~0 (ошибки в логе — "Free usage limit" до 2 ноября, до перехода).
- long-session: 4–10/день (100–500 сообщений). Повторы tool calls: 0 кандидатов.
- Типовые сессии: 45 msgs = 0.048 USD; 110 = 0.21; 227 = 0.36; 539 = 0.77. USD/сообщение build-flash ≈ 0.001.

## Рекомендации (без применения)

P0: (1) agents.compaction.model = deepseek/deepseek-flash-offpeak#low; (2) agents.plan/ask → flash#low, убрать max; (3) включить dailyNativeUSD = 2–3; (4) ручной billing-ввод из аккаунта для сверки.
P1: (5) compaction.buffer 30000 → 40000 (реже компактации, кэш дёшев); (6) handoff-порог 100 → 80; (7) keep 20000 → 15000 (опция, риск качества).
P2: (8) benchmark-хамма 6 типовых задач + сравнение (механизм comparisonKey уже есть); (9) playwright MCP без --eager (малая выгода); (10) НЕ добавлять LiteLLM/Langfuse/semantic cache — избыточно.

Сценарии (типовая задача ~150 msgs, baseline 0.30 USD):
- Консервативный: −5–8% (≈0.28), −0.10–0.15 USD/день.
- Реалистичный: −18–22% (≈0.24), −0.40–0.50 USD/день.
- Максимальный: −30–35% (≈0.21), −0.60–0.80 USD/день (риск качества, нужен benchmark).
Мелкие задачи (ask/fix, 20–40 msgs) уже сейчас 0.02–0.05 USD.
Месяц: ~70 → ~55 (реалистично), ~45–50 (максимум).

## Следующий шаг

Ждать согласования P0. После — правки opencode.jsonc / opencode-costs.json, проверка, benchmark.
