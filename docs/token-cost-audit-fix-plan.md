# Аудит экономии токенов (deepseek / qwen / kimi) — план исправлений

Дата аудита: 2026-11-18. Клиент: OpenCode v2.3.2. Окно данных: 60 последних
снимков сессий проекта harness в
`~/.local/state/harness/optimize/opencode/90277afafe4bf1a0/sessions/`
(запросы 11.11–18.11, нативные счётчики `tokens`, `nativeReportedUSD`).
Часовой пояс пользователя: Москва, UTC+3.

## Что проверено и работает (подтверждено данными)

1. Потолок вывода 8192 соблюдается фактически: максимум `output + reasoning`
   за окно — ровно 8192 у `deepseek-flash`, `kimi-for-coding`, `k3.1-pro`,
   `qwen4-max`; запросов свыше 8192 — ноль; `finish=length` единичны (5 на
   ~3700 запросов). DeepSeek берёт потолок из `limit.output`
   (`opencode/opencode.jsonc:20,34`), kimi/qwen — из `max_tokens` в теле
   (`opencode/kimi-tuning/tuning.mjs:23-24`, `opencode/qwen-oauth/models.mjs:16,22`).
2. Кеш читается на всех трёх провайдерах: cacheRead/input ≈ 148.9M/4.85M
   (deepseek-flash#high, ~96.8%), 16.5M/0.51M (kimi-for-coding#high, ~97%),
   14.9M/1.04M (qwen3.8-flash, ~93.4%). `cacheWrite` везде 0 — записи кеша
   не тарифицируются.
3. Дублирования счётчиков нет: нативный `input` не включает `cacheRead`
   (cacheRead кратно больше input), `output` не включает `reasoning`
   (reasoning бывает больше output). Нативная стоимость OpenCode совпадает
   с формулой harness `(input*rIn + cacheRead*rCache + (output+reasoning)*rOut)/1e6`
   с ratio ровно 1.0 на 13–18.11 (`opencode/cost-policy.mjs:55-61`).
   `opencode/observations.mjs:51-55` и `opencode/cost-report.mjs:318-322`
   трактуют семантику верно.
4. Инструменты: схемы инструментов входят в стабильный кешируемый префикс
   (hit rate 93–97% это подтверждает); крупные результаты инструментов
   ограничиваются `opencode/output-bounds.mjs`; MCP-схемы сжимаются прокси
   (`--compact` для tokensave, частичный каталог playwright). Упоминания
   `tokensave_*`/`rag_*` в коде `execute` не считаются доказательством
   вызова (`mentionsAreExecutionProof: false`) — дублирования учёта нет.
5. Варианты `#low`/`#high` у qwen различаются только `reasoning_effort`
   (`opencode/qwen-oauth/models.mjs:17-25`); kimi-tuning не переписывает
   чужие поля вариантов (`opencode/kimi-tuning/tuning.mjs:24`). База = low.
6. Расписание пиковых окон DeepSeek в `opencode/cost-policy.mjs:17`
   (01–04 и 06–10 UTC, будни, кроме праздников КНР) совпадает с
   документацией провайдера. Для Москвы пик = 04:00–07:00 и 09:00–13:00 МСК.

## Замечание F1 (подтверждено, среднее): завышенный `limit.output` у qwen

`opencode/qwen-oauth/index.ts:94`:

```ts
model.limit = { context: tuning.context, output: tuning.outputLimit }
```

`tuning.outputLimit` — сырое серверное окно (`outputWindowSize` каталога,
резерв 32768, `opencode/qwen-oauth/models.mjs:10`), тогда как фактический
потолок запроса — `cap = min(8192, outputWindowSize)` в `max_tokens` тела.
OpenCode выводит `maxTokens` запроса из `limit.output` (в бинарнике
v2.3.2: `maxTokens:qz(z.limit…)`), использует `limit.output` как потолок
thinking-бюджета вариантов (`r=e.limit.output`, бюджет ≤ `limit.output-1`)
и при производном контексте (`context = inputCap + limit.output`).
Сейчас спасает только перекрытие `max_tokens` в теле (подтверждено:
`qwen4-max` останавливается ровно на 8192 с `finish=length`), то есть
корректность зависит от порядка слияния тела, а декларируемый лимит
завышен в 4 раза. У kimi аналогичный лимит уже выровнен
(`opencode/kimi-tuning/tuning.mjs:12-13`).

### Исправление (для исполняющей модели)

1. `opencode/qwen-oauth/models.mjs`: в возвращаемом объекте `modelTuning`
   добавить поле с применённым потолком, например `outputCap: cap`
   (строки 26-33). Сырое поле `outputLimit` сохранить — его проверяют
   существующие тесты и оно описывает серверное окно.
2. `opencode/qwen-oauth/index.ts:94`: заменить
   `output: tuning.outputLimit` на `output: tuning.outputCap`.
   Больше ничего в `buildModels` не менять: `body` и варианты уже несут
   `max_tokens = cap`.
3. `ai-hooks/test/test-qwen-models.mjs`: рядом с существующими проверками
   `outputLimit` (строки 16, 32, 36, 55) добавить проверки `outputCap`:
   32768 → 8192, 4096 → 4096, 20000 → 8192; для модели без thinking
   поведение `outputCap` не меняется. Комментарии в код не добавлять.
4. Проверить, что другие потребители `tuning.outputLimit` отсутствуют
   (поиск по репозиторию: только `index.ts:94` и тесты).

### Проверка

- `node --test --test-concurrency=1 ai-hooks/test/test-qwen-models.mjs ai-hooks/test/test-qwen-oauth.mjs ai-hooks/test/test-qwen-sse.mjs`
- полный прогон по правилам репозитория:
  `node --test --test-concurrency=1 ai-hooks/test/test-*.mjs`
- после установки (`install.sh` → `bin/opencode-install.mjs`) убедиться,
  что каталог qwen отдаёт `limit.output = 8192` (или серверное окно, если
  оно меньше), а `max_tokens` тела совпадает с `limit.output`; контрольный
  запрос на `#high` не должен превышать потолок.

## Замечание F2 (наблюдение, низкое): источник тарифного окна называется «native-cost»

256 запросов 11.11/13.11/18.11 имеют `pricingWindowClockAgrees=false`.
Это не ошибка тарификации: `nativeReportedUSD` — оценка OpenCode по
статическим ценам конфига (непиковые, `opencode/opencode.jsonc:25-29,39-43`),
а не счёт провайдера; в пиковое окно фактический счёт вдвое выше нативной
оценки (документировано в `docs/opencode.md:33`). Эпизод 11.11 18:05 UTC
(нативная стоимость совпала с пиковой формулой) объясняется временными
пиковыми ценами в live-конфиге того дня (резервные копии
`~/.config/opencode/opencode.jsonc.bak-1794420*`). Формула и расписание
harness считаются сверенными с почасовым счётом провайдера
(`docs/opencode.md:31`).

Действие (опционально, без изменения логики): в `docs/opencode.md` и в
пояснении отчёта зафиксировать, что `pricingWindowSource: "native-cost"`
(`opencode/cost-policy.mjs:93-96`) означает «оценка по ценам конфига»,
а не счёт провайдера; переименование значения потребует правки тестов
`ai-hooks/test/test-opencode-cost-policy.mjs` и строк отчёта — делать
только отдельным решением.

## Рекомендации по экономии (привязаны к данным, эффект — гипотеза до замера)

1. Пиковое окно для Москвы 09:00–13:00 МСК (и 04:00–07:00): тяжёлые
   DeepSeek-задачи выгоднее запускать после 13:00 МСК либо в 07:00–09:00
   МСК — непиковые ставки вдвое ниже. Для пакетных задач использовать
   `bin/opencode-offpeak.mjs` / `nextOffPeakAt` (`opencode/cost-policy.mjs:104`).
2. В пиковые часы маршрутизировать задачи с глубоким рассуждением на
   qwen/kimi `#high`: подписка не тарифицируется за токен (`cost: []`,
   `nativeReportedUSD = 0` во всех наблюдавшихся сессиях), кеш там работает
   (93–97%). DeepSeek-flash#low оставлять для дешёвых непиковых задач.
3. Переход на `#high` на DeepSeek оплачивает reasoning по ставке вывода
   (в окне наблюдения у flash#high reasoning 667K против output 459K;
   в пик ставка вывода 1.2 USD/M против 0.6). Сопоставимых задач low/high
   в данных нет — перед массовым переходом замерить одну и ту же задачу
   на обоих вариантах (протокол `skills/shared/optimization-observations.md`),
   не объявлять экономию/перерасход без замера.
4. Исправление F1 убирает зависимость потолка от порядка слияния тела и
   завышенный резерв вывода у qwen; прямой денежный эффект не заявляется.
5. Уже работает и не требует изменений: границы вывода инструментов,
   сжатие MCP-схем, стабильный кешируемый префикс, компактация на
   `deepseek-flash#low` с `keep.tokens=10000`, `buffer=25000`.
