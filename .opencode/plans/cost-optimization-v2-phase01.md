# Cost Optimization V2 — Фазы 0–1: отчёт и план

Статус: Фазы 0–1 выполнены. Реализация Фаз 2–3 не начата.
Дата: 2026-11-07. Ветка: `codex`. OpenCode 2.2.6.

## 1. Фаза 0 — совместимость

### 1.1 Runtime

- `opencode v2.2.6`, Node v24.18.0, сервис `http://127.0.0.1:49374`.
- Лог: `~/.local/share/opencode/log/opencode.log`.
- Плагин: `~/.config/opencode/plugins/harness -> /home/enkeym/harness/opencode`.
- Глобальный конфиг: `~/.config/opencode/opencode.jsonc` (compaction auto=true, keep 20000, buffer 30000, background_compaction=false, default model `deepseek/deepseek-flash`).
- Пороги: `~/.config/harness/opencode-costs.json` (timeZone Europe/Moscow, dailyProviderCNY 25, `dailyNativeUSD: null`, sessionAssistantMessages 100, repeatedToolCalls 3, consecutiveFailures 3).

### 1.2 Подтверждённые точки расширения

Источник: официальная документация V2 (`https://opencode.ai/docs/build/plugins/server`, `https://opencode.ai/docs/compaction`) + фактическая регистрация в коде.

| API | Где уже используется | Назначение в проекте |
| --- | --- | --- |
| `ctx.session.hook("compaction")` | `opencode/harness.js:129-132`, `opencode/loop-guard.mjs` | наблюдение перед компактацией, инъекция handoff-промпта |
| `ctx.session.hook("context")` | `opencode/harness.js:208-226`, `opencode/loop-guard.mjs` | dedup контекста, лимиты чтений |
| `ctx.event.subscribe` | `opencode/harness.js:134-142` | `session.execution.succeeded/failed/interrupted`, `session.model.selected` |
| `ctx.tool.hook("execute.before"/"execute.after")` | `opencode/loop-guard.mjs` | защита от циклов инструментов |
| `ctx.model.transform` | `opencode/harness.js:56-77` | лимиты context/input/output, отключение Pro по бюджету |
| `ctx.session.compact` | доступен, не используется | управляемая компактация |
| `ctx.permission.hook("evaluate")` | доступен, не используется | политика разрешений |
| transforms: `model`, `provider`, `agent`, `tool`, `mcp`, `skill`, `command`, `session.instructions.entry.put` | частично | точки для будущих фаз |

Доступ к сообщениям перед запросом: `ctx.session.hook("context")` даёт активный контекст; полная история — через session API (`collectObservations`). Плагин не может безопасно переписывать tool output на уровне провайдера — только через tool hooks и context hook.

### 1.3 Существующий конвейер измерений

`session event` → `observe()` (`opencode/harness.js:106-124`) → `collectObservations()` (`opencode/observations.mjs:159-217`) → `observationAPI(context)` (там же `:219-232`, `version: context.app.version`) → `refreshCostReport()` (`opencode/cost-report.mjs:632-673`) → предупреждения/бюджет (`harness.js:87-105`).

Запись: `~/.local/state/harness/optimize/opencode/sessions/<ses>.json`; дневные отчёты: `~/.local/state/harness/optimize/opencode/reports/YYYY-MM-DD.{json,md,warnings.json}`.

### 1.4 Уже реализовано и не требует переписывания

- Тарифы peak/offPeak и расчёт: `opencode/cost-policy.mjs` (`deepseekCostBreakdownAt`, `isPeakAt`).
- Маршрутизация и off-peak алиасы: `opencode/model-routing.mjs`.
- Семейства сессий, сравнения, пороги, предупреждения: `opencode/cost-report.mjs` (`sessionFamilies`, `comparisons`, `buildCostReport`).
- Dedup контекста: `opencode/context-cache.mjs`.
- Loop guard: `opencode/loop-guard.mjs`.
- Handoff / brief / task context: `opencode/handoff.mjs`, `opencode/brief.mjs`, `opencode/task-context.mjs`.
- Бюджет и downgrade Pro: `opencode/harness.js:56-105`.
- Ручной billing-импорт: `validateBilling` (`cost-report.mjs:67-94`), CLI `bin/opencode-costs.mjs billing`.

### 1.5 Семантика compaction (подтверждено)

- `buffer` — абсолютное число токенов, удерживаемых свободными, не «точка старта» и не процент. При окне 1 048 576 текущие 30 000 ≈ 2.9%, тогда как дефолт V2 — `"15%"` (компактация около 850k).
- `keep.tokens` — сохраняемый хвост (сейчас 20 000).
- `agents.compaction.model` поддерживается.
- `experimental.background_compaction` поддерживается.
- Native compaction (OpenAI Responses) к DeepSeek не применяется.

Вывод: текущие 35 компактаций/день (~22% расходов) — следствие настройки `buffer`, а не поведения модели. Это Фаза 2, не трогаем сейчас.

## 2. Блокер Фазы 1 (устранён)

Версия была жёстко зашита в двух местах:

- `opencode/observations.mjs` — `if (version !== "2.2.5") throw ...`
- `opencode/cost-report.mjs` — `record.clientVersion !== "2.2.5" || ...`

Сейчас `context.app.version = "2.2.6"`, поэтому `collectObservations` падал, `harness.js` писал `Harness observation failed`, записи не обновлялись. Заменено на общий `supportedObservationVersion` (2.2.x, patch ≥ 5) при сохранении структурных проверок схемы: неизвестные поля дают `null` и gap, а не выдуманные значения.

## 3. Gap-анализ обязательных полей usage

Текущая запись шага: `observations.mjs:83-88` (`step`) + `toolSummary` (`:47-72`).

| Поле | Источник в OpenCode | Сейчас | Действие |
| --- | --- | --- | --- |
| timestamp | `message.time.created` (ms) | есть в `step.time` | добавить ISO-производную/оставить ms, фиксировать timeZone |
| sessionId | `info.id` | есть на уровне record | добавить в per-request запись |
| requestId | `message.native.responseId` | нет | добавить `step.requestId` |
| taskId | task-context/brief state | нет | связать с известным taskId, иначе `null` (не синтезировать) |
| model | `message.model.{providerID,id}` | есть | без изменений |
| reasoningVariant | `message.model.variant` | нет | добавить `step.reasoningVariant` |
| inputTokens | `tokens.input` | есть | без изменений |
| cacheReadTokens | `tokens.cache.read` | есть | без изменений |
| cacheMissTokens | производное от `input`/`cacheRead` | нет | добавить производное поле (см. §5, требует сверки) |
| outputTokens | `tokens.output` | есть | без изменений |
| reasoningTokens | `tokens.reasoning` | есть | без изменений |
| costUSD | `message.cost` | `nativeReportedUSD` | добавить алиас в per-request сводке |
| pricingWindow | `isPeakAt(step.time.created)` | нет | добавить `"peak"`/`"offPeak"` |
| requestType | `step.type` + `agent` | частично (`type`) | добавить нормализованный `requestType` |
| toolCalls | `step.tools` | есть | добавить количество и суммарный `durationMs` |
| durationMs | `time.completed - time.created` | только per-tool | добавить длительность запроса |
| compactionEvent | `step.type === "compaction"` | частично | явный boolean/epoch |

## 4. Минимальные правки (расширение существующего)

1. `opencode/observations.mjs`
   - снять точный пин версии, оставить структурные проверки;
   - в `summarizeSession` добавить перечисленные поля аддитивно; отсутствующие — `null` + gap;
   - `cacheMissTokens` и `pricingWindow` считать производными в момент записи;
   - не менять `assessment`/`handoff` merge в `save()`.
2. `opencode/cost-report.mjs`
   - та же версионная совместимость;
   - `usage()` дополнить агрегатами `cacheMissTokens`, `reasoningTokens`, `toolCalls`, `durationMs`, `compactions`;
   - billing-сверку не переписывать — использовать `validateBilling` и `billingDiscrepancyPercent`.
3. `opencode/cost-policy.mjs`
   - без изменений до проверки §5.
4. `bin/opencode-costs.mjs`
   - без новых команд; при необходимости — вывод уже существующей сверки.
5. `~/.config/harness/opencode-costs.json`
   - только пороги; `dailyNativeUSD` выставить после калибровки (сейчас `null`).

Схема остаётся обратно совместимой: новые поля аддитивны, старые записи читаются с `null`. `schemaVersion` повышается, чтение старых файлов не ломается. Перезапись истории не выполняется.

## 5. Обязательная проверка перед фиксацией формул

Проверено на 10 641 сообщении из локальных записей (все, где есть `tokens` и `cost`):

| Гипотеза | Совпадений с native cost |
| --- | ---: |
| `input·rate + cacheRead·cacheReadRate + (output+reasoning)·outputRate` | **10 641 / 10 641** |
| то же без `reasoning` | 2 006 |
| `(input − cacheRead)·rate + …` | 11 |
| `(input + cacheRead)·rate + …` | 11 |

Вывод:

1. `tokens.input` — это уже cache-miss; `tokens.cache.read` тарифицируется отдельно. Поэтому `cacheMissTokens = input`, а `input + cacheRead` не суммируется.
2. `tokens.reasoning` **не** входит в `tokens.output`: он тарифицируется как output сверх него. Текущая формула `(output + reasoning) · rate` верна, двойного учёта нет.
3. `deepseekCostBreakdownAt` менять не нужно; он подтверждён как эталон.

## 5a. Обнаруженное расхождение тарифного окна (требует сверки с billing)

По дням native cost перестал совпадать с пересчётом по «непиковым» часам с **2026-11-03**:

| Дата | Сообщений по пиковым ставкам | по непиковым |
| --- | ---: | ---: |
| 2026-11-01 | 0 | 36 |
| 2026-11-02 | 0 | 1 995 |
| 2026-11-03 | 3 809 | 195 |
| 2026-11-04 | 1 056 | 0 |
| 2026-11-05 | 2 364 | 0 |
| 2026-11-06 | 1 186 | 0 |
| 2026-11-07 | 46 | 0 |

С 2026-11-03 native cost ровно в 2 раза выше пересчёта по off-peak ставкам при любом часе, включая выходные. Это либо смена тарификации/окна у провайдера, либо устаревшая таблица. Гипотезу не подтверждать догадкой: сверка идёт через billing-файл (раздел 6), после чего правится `deepseekTokenRates`/`peakWindowsUTC` и `deepseekPricing.checkedAt`.

Пока расхождение не объяснено, `recomputedUSD` занижает расход с 2026-11-03; `nativeRequestReportedUSD` и бюджет остаются корректными. В отчёте это видно как предупреждение `pricing-window-mismatch` и поле `usage.pricingWindowMismatches`.

## 6. Сверка с официальным billing DeepSeek

Существующий канал, новую инфраструктуру не создаём:

```
node ~/.config/harness/repo/bin/opencode-costs.mjs billing --file ~/billing/YYYY-MM-DD.json
```

Формат (валидируется `validateBilling`): `date` (YYYY-MM-DD), `currency` (`CNY`/`USD`), `cost`, опционально `apiRequests`, `tokens`, `accountScope`, `timeZone`, `reportedAt`.

- Сравнение: native `recomputedUSD` по дню vs billing; порог `billingDiscrepancyPercent = 5`.
- Ключи API не сохраняются; billing — ручной файл, без сетевых вызовов.
- Часовой пояс: Europe/Moscow (`localDate`), billing должен указывать свой `timeZone` — иначе расхождение на границе суток.

## 7. Тесты и проверки

- `ai-hooks/test/test-opencode-observations.mjs` — схема записи, новые поля, отсутствие двойного учёта.
- `ai-hooks/test/test-opencode-cost-report.mjs` — агрегаты, billing, версии.
- `ai-hooks/test/test-opencode.mjs` — регистрация хуков и путь `observe`.
- Полный прогон: `node --test --test-concurrency=1 ai-hooks/test/test-*.mjs` — **203/203 pass**.
- Ручная проверка: одна сессия → запись содержит все обязательные поля; `recomputedDeltaUSD` в пределах допуска; повторный запуск не дублирует шаги (`uniqueSteps`).

## 7a. Что реализовано

- `opencode/cost-policy.mjs`
  - `deepseekPricingWindowAt(modelId, tokens, costUSD, createdAt)` — окно по native cost с фолбэком на часы и флагом `agreesWithClock`;
  - `pricedTokens`/`breakdownAtRates` — общий разбор модели и ставок;
  - `deepseekCostBreakdownAt` не изменил расчёт.
- `opencode/observations.mjs`
  - `supportedObservationVersion` — 2.2.x, patch ≥ 5;
  - `requestTypeOf`, `describeRequest` — все обязательные поля: `timestamp`, `sessionId`, `requestId` (`native.responseId`), `taskId`, `model`, `reasoningVariant`, `inputTokens`, `cacheReadTokens`, `cacheMissTokens`, `outputTokens`, `reasoningTokens`, `costUSD`, `pricingWindow` (+ source/clockAgrees), `requestType`, `toolCalls`, `durationMs`, `compactionEvent`;
  - `step.request` пишется в каждую запись; `schemaVersion` → 2; gap `pricing-window-mismatch`;
  - `accounting.tokenSemantics` фиксирует семантику полей;
  - `observationAPI.task` читает `taskId` из task-context через общий `taskContextKey`.
- `opencode/task-context.mjs` — `taskContextKey` экспортирован, вызовы обновлены.
- `opencode/cost-report.mjs`
  - принимает `schemaVersion` 1 и 2 и любой 2.2.x;
  - `usage()` агрегирует `cacheMissTokens`, `toolCalls`, `durationMs`, `requestTypes`, `pricingWindows`, `pricingWindowMismatches`;
  - предупреждение `pricing-window-mismatch`;
  - `formatCostReport` показывает новые агрегаты; схема отчёта → 2.
- Старые записи (`schemaVersion` 1, без `step.request`) читаются без миграции: тип запроса берётся из `step.type`, тарифные окна пустые.


## 8. Feature flags и rollback

- Измерения — аддитивны и не влияют на API-запросы; отдельный флаг не нужен, кроме kill-switch на случай несовместимости: env `HARNESS_OBSERVATIONS=off` (проверяется в `observe()`).
- Любая оптимизация Фаз 2–3 — отдельный флаг в `defaultCostConfig` (конфиг отвергает неизвестные ключи, `validateCostConfig`), по умолчанию `false`.
- Rollback Фазы 1 — возврат точного пина версии; записи совместимы в обе стороны.

## 9. Что не делается в этой фазе

- Не меняются `buffer`, `keep.tokens`, `agents.compaction.model`.
- Не трогаются handoff/brief пороги.
- Не внедряются Context Budget Manager, Relevance Scoring, Delta Injection, Virtualization.
- Не делается автоматический downgrade модели сверх существующего правила build/Pro и дневного бюджета.

## 10. Что дальше

Выполнено без подтверждения, в рамках согласованной Фазы 1: версионная совместимость, аддитивные поля, агрегаты, предупреждение о тарифном окне, тесты.

Требует решения пользователя:

1. Сверить расхождение тарифного окна (§5a) через billing-файл за 2026-11-03…2026-11-07 и, при подтверждении, обновить `deepseekTokenRates`/`peakWindowsUTC`.
2. Выставить `dailyNativeUSD` в `~/.config/harness/opencode-costs.json` (сейчас `null`) после калибровки — это правка глобального конфига.
3. Перезапустить `opencode service`, чтобы плагин подхватил новый код (`step.request` начнёт писаться в новые записи).
4. Приступать ли к Фазе 2 (`buffer`, `keep.tokens`, `agents.compaction.model`).
