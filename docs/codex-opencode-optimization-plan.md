# Оптимизация openai-моделей (gpt-6-sol / gpt-6.1-sol) в OpenCode — аудит и кодовый план

Дата аудита: 2026-11-18. Клиент: OpenCode v2.3.2 (данные сняты на v2.3.0/v2.2.5).
Окно данных: 60 снимков сессий проекта harness в
`~/.local/state/harness/optimize/opencode/90277afafe4bf1a0/sessions/`
(запросы 11.11–18.11, нативные счётчики `tokens`, `nativeReportedUSD`).
Часовой пояс пользователя: Москва, UTC+3.

Область (подтверждена пользователем): модели `gpt-6-sol` и `gpt-6.1-sol`
провайдера `openai` — фактически используемые «codex»-модели. Линейка
`gpt-5.3-codex*` отключена в live-конфиге и в область не входит. Codex CLI
не устанавливать (явный запрет); оптимизация только средствами OpenCode.
Deliverable: план для исполняющей модели; правки кода/конфига в рамках
аудита не вносились. Образец формата: `docs/token-cost-audit-fix-plan.md`.

## Что проверено и работает (паритет подтверждён данными)

1. Кеш читается: cacheRead/(input+cacheRead) ≈ 95.0% у `gpt-6-sol#high`
   (8 163 200 / 8 588 590), 96.3% у `gpt-6-sol#medium` (5 873 792 / 6 101 515),
   86.2% у `gpt-6.1-sol#high` (1 783 936 / 2 068 416). `cacheWrite` везде 0 —
   кеширование OpenAI неявное, записи не тарифицируются. Действий не требует.
2. Раздельный учёт: нативный `input` не включает `cacheRead`, `output` не
   включает `reasoning` (семантика OpenCode v2.3.2 подтверждена прошлым
   аудитом; `opencode/observations.mjs:51-55`, `opencode/cost-report.mjs:318-322`
   трактуют её верно). Reasoning у sol-моделей ненулевой: 13 255 / 7 377 / 3 432.
3. Потолок фактически не превышается: максимум `output` за запрос — 2 089
   (`gpt-6-sol#high`), 1 358 (`#medium`), 3 715 (`gpt-6.1-sol#high`);
   `finish=length` — ноль, запросов свыше 8192 — ноль. Но это удача, а не
   настройка: декларированный лимит вывода — 128 000 (см. F1).
4. База = low: `openai.settings.reasoningEffort = "low"` задан и в базовом
   конфиге (`opencode/opencode.jsonc:47-49`), и в live-конфиге. Лестница
   вариантов приходит из каталога (`reasoning_options`: low/medium/high/xhigh/max).
   Запросов с `#low` в окне данных нет — это привычка использования, а не
   пробел конфига.

## Замечание F1 (подтверждено, высокое): нет потолка вывода 8192

Каталог `~/.cache/opencode/models.json` (mtime 01.11): у `gpt-6-sol` и
`gpt-6.1-sol` `limit: {context: 1050000, input: 922000, output: 128000}`.
Ни базовый, ни live-конфиг не переопределяет `limit.output` этих моделей
(в live-конфиге для openai только `settings.reasoningEffort` и `disabled`-флаги
других моделей). OpenCode выводит `maxTokens` запроса из `limit.output`
(проверено в бинарнике v2.3.2 прошлым аудитом, см. F1 в
`docs/token-cost-audit-fix-plan.md`) и использует `limit.output` как потолок
thinking-бюджета вариантов. Следовательно, sol-модели могут выдать до 128 000
токенов за запрос, а thinking-бюджет `#high`/`#xhigh` не ограничен рабочими
8192. Для сравнения: deepseek берёт потолок из конфига
(`opencode/opencode.jsonc:20,34`), kimi/qwen — из `max_tokens` в теле
(`opencode/kimi-tuning/tuning.mjs:23-24`, `opencode/qwen-oauth/models.mjs`).

## Замечание F2 (факт подтверждён, причина требует проверки): нулевая стоимость с 15.11

Агрегация openai-запросов по 60 снимкам (assistant-записи `sequence`,
`model.providerID == "openai"`):

| Модель | n | input | output | reasoning | cacheRead | USD |
|---|---|---|---|---|---|---|
| gpt-6-sol#high | 152 | 425 390 | 27 607 | 13 255 | 8 163 200 | 2.5071 |
| gpt-6-sol#medium | 128 | 227 723 | 16 188 | 7 377 | 5 873 792 | 0 |
| gpt-6.1-sol#high | 68 | 284 480 | 12 477 | 3 432 | 1 783 936 | 0 |
| gpt-6-luna#xhigh | 1 | 10 181 | 5 | 0 | 0 | 0.0010206 |

Оплаченные запросы (125) все датированы 13.11; нулевые (224, из них 9
неуспешных) — все 15–16.11. Обе группы на клиенте v2.3.0. Исключено:
variant-специфичность (тот же `#high` оплачен 13.11 и нулевой 15.11),
compaction (`compactionEvent` везде false), retry (лишь 2 из 224). Кеш
каталога не менялся с 01.11. Цены в каталоге для обеих моделей есть:
`cost {input: 2, output: 10, cache_read: 0.2/0.1, cache_write: 2.5}` USD/1M.
Контроль: у `gpt-6-luna#xhigh` (v2.2.5) стоимость точно равна формуле каталога
(10181×0.1 + 5×0.5)/1e6 = 0.0010206 — варианты наследуют цену базовой модели.

OpenAI-credential в БД OpenCode (`credential`, active=1, без чтения секретных
полей) создан 01.11 23:41 МСК и обновляется refresh-токеном (последнее
обновление 18.11) — OAuth-подключение; у kimi/qwen ярлык явно «subscription».
Гипотезы по приоритету: (а) OAuth-подписка не тарифицируется за токен, и
OpenCode репортит 0 (паттерн qwen, `docs/opencode.md:37`); (б) между 13.11 и
15.11 изменился расчёт стоимости для openai OAuth (обновление клиента/каталога
на стороне models.dev); (в) переключение с API-ключа на OAuth. Проверка —
шаг 4 плана; до неё нельзя заявлять, что это баг учёта harness.

## Замечание F3 (подтверждено, среднее): нет ограничения контекста под дешёвый тир

Каталог задаёт тир: при контексте свыше 272 000 цена удваивается
(`tiers: [{tier: {type: "context", size: 272000}, input: 4, output: 15,
cache_read: 0.4/0.2, cache_write: 5}]`). При `limit.context = 1 050 000` и
compaction `buffer: 25000` (`opencode/opencode.jsonc:62-68`) сжатие не
срабатывает до почти миллиона токенов — длинные сессии регулярно платят ×2
(или уходят в перерасход подписки). У deepseek вход ограничен 120 000
(`opencode/opencode.jsonc:20,34`). Для sol-моделей нужен `limit.input`,
удерживающий производный контекст (`inputCap + limit.output`, механика
бинарника v2.3.2) ниже 272 000.

## Замечание F4 (низкое): лестница вариантов шире паттерна harness

Каталог даёт none/low/medium/high/xhigh/max (у `gpt-6.1-sol` без none).
Паттерн harness для deepseek/qwen/kimi — два варианта `#low`/`#high`
(`capabilities.reasoning.effort: ["low", "high"]`,
`opencode/opencode.jsonc:22,36`). Лишние варианты не ломают учёт, но
загромождают выбор и провоцируют дорогие xhigh/max. Переопределение
опционально (шаг 1); если OpenCode не применит `capabilities` к каталожной
модели — оставить лестницу как есть (база уже low).

## Кодовый план для исполняющей модели

Принципы: переиспользовать существующее (конфиг-паттерн deepseek, общий
модуль `opencode/model-tuning.mjs`, паттерн kimi-tuning); комментарии в код
не добавлять; секреты не в Git; чужие поля live-конфига не трогать; Codex CLI
не устанавливать. Основной путь — только конфиг: OpenCode выводит `maxTokens`
из `limit.output`, поэтому тюнинг-плагин — спекулятивная абстракция и нужен
лишь если шаг 2 это опровергнет.

### Шаг 1. Переопределения моделей в базовом конфиге

Файл `opencode/opencode.jsonc`, секция openai (строки 47–49). Заменить на:

```jsonc
"openai": {
  "settings": { "reasoningEffort": "low" },
  "models": {
    "gpt-6-sol": {
      "limit": { "input": 250000, "output": 8192 },
      "capabilities": { "reasoning": { "supported": true, "effort": ["low", "high"] } }
    },
    "gpt-6.1-sol": {
      "limit": { "input": 250000, "output": 8192 },
      "capabilities": { "reasoning": { "supported": true, "effort": ["low", "high"] } }
    }
  }
}
```

Обоснование чисел: output 8192 — рабочий потолок всего harness
(`DEFAULT_OUTPUT_CAP`, `opencode/model-tuning.mjs:1`); input 250 000 —
производный контекст 250 000 + 8192 = 258 192 < 272 000 (дешёвый тир),
compaction с buffer 25 000 срабатывает около ~233k. Более строгая альтернатива
— input 120 000 как у deepseek; без решения пользователя не применять.
`cost` не переопределять: цены уже есть в каталоге, дублирование источника
создаст оценку вместо счёта (семантика F2 прошлого аудита). Установщик
объединяет базовый конфиг с пользовательским при каждой установке
(`docs/opencode.md:5`), пользовательские значения приоритетнее; в openai-секции
live-конфига нет записей gpt-6-sol/gpt-6.1-sol — конфликта не ожидается,
проверить в шаге 2.

### Шаг 2. Проверка слияния и потолка

1. `install.sh --check`; затем установка (резервные копии создаются автоматически).
2. Убедиться, что merged-конфиг `~/.config/opencode/opencode.jsonc` сохранил
   переопределения (глубокое слияние `models`).
3. Перезапустить клиент; в списке моделей `gpt-6-sol` и `gpt-6.1-sol` имеют
   `limit.output = 8192`, `limit.input = 250000`; варианты `#low`/`#high`
   (если `capabilities` не применился — зафиксировать и оставить лестницу,
   F4 опционален).
4. Контрольные запросы `#low` и `#high`: в теле запроса
   `max_completion_tokens = 8192` (лог `~/.local/share/opencode/log/opencode.log`),
   `output + reasoning ≤ 8192`; при принудительно длинной генерации
   `finish = length` ровно на 8192.
5. Повторный префикс → `cacheRead > 0`, `cacheWrite = 0`; значение
   `nativeReportedUSD` зафиксировать для шага 4.

Если п.4 покажет, что `maxTokens` не следует из конфиг-переопределения
(тело без потолка или 128 000) — перейти к шагу 3.

### Шаг 3 (условный). Тюнинг-плагин openai — только если провалился шаг 2.4

Создать `opencode/openai-tuning/` по образцу `opencode/kimi-tuning/`
(`index.ts:1-21` — регистрация, `tuning.mjs:1-26` — трансформация), общий
модуль `opencode/model-tuning.mjs` переиспользовать:

```ts
import { Plugin } from "@opencode/plugin"
import { OPENAI_PROVIDER_ID, openaiCaps, tuneOpenaiModel } from "./tuning.mjs"

export default Plugin.define({
  id: "openai.tuning",
  async setup({ provider }) {
    const caps = openaiCaps(process.env)

    await provider.transform((editor) => {
      const record = editor.get(OPENAI_PROVIDER_ID)
      if (!record) return
      for (const modelID of record.models.keys()) {
        editor.models.update(OPENAI_PROVIDER_ID, modelID, (model) => {
          tuneOpenaiModel(model, caps)
        })
      }
    })

    return () => {}
  }
})
```

```js
import { clampOutputCap, envPositiveInt, withMaxTokens } from "../model-tuning.mjs"

export const OPENAI_PROVIDER_ID = "openai"

export function openaiCaps(env = {}) {
  const cap = envPositiveInt(env.OPENAI_OUTPUT_CAP, 8192)
  return { cap }
}

export function tuneOpenaiModel(model, caps) {
  const output = clampOutputCap(model.limit?.output, caps.cap)
  model.limit = { ...(model.limit ?? {}), output }
  model.settings = { ...(model.settings ?? {}), body: withMaxTokens(model.settings?.body, output) }
  model.variants = (model.variants ?? []).map((variant) => ({ ...variant, body: withMaxTokens(variant.body, output) }))
  return model
}
```

Нюансы: (1) OpenAI reasoning-модели принимают `max_completion_tokens`, а не
`max_tokens`; если тело с `max_tokens` отклоняется, расширить
`withMaxTokens(body, maxTokens, field = "max_tokens")` в общем модуле
(совместимо с kimi/qwen) и передавать `"max_completion_tokens"` — проверить
контрольным запросом. (2) Плагин применяется ко всем моделям провайдера
openai; если нужен только sol-набор — фильтровать по `modelID` внутри
трансформации (решение пользователя, по умолчанию весь провайдер, как у
kimi). (3) Добавить `"./plugins/harness/openai-tuning"` в список `plugins`
базового конфига (`opencode/opencode.jsonc:72-76`); чужие поля (`cost`,
`reasoning_effort`, `baseURL`) не переписывать — принцип kimi-tuning
(`docs/opencode.md:39`). (4) Тесты по образцу существующих тестов kimi-tuning
(найти в `ai-hooks/test/`), затем
`node --test --test-concurrency=1 ai-hooks/test/test-*.mjs`.

### Шаг 4. Диагностика F2 (нулевая стоимость)

1. Проверить наличие `OPENAI_API_KEY` в окружении и `~/.config/harness/env`
   (только имя, значение не логировать).
2. Контрольный запрос с текущей auth; сравнить `nativeReportedUSD` с формулой
   каталога для контекста < 272 000:
   `(input×2 + cacheRead×0.2 + (output+reasoning)×10)/1e6` (gpt-6-sol;
   у gpt-6.1-sol cache_read 0.1).
3. Если USD = 0: проверить свежесть каталога models.dev (OpenCode может
   запрашивать его при старте; локальный `models.json` — кеш от 01.11) и путь
   расчёта стоимости для openai OAuth в бинарнике v2.3.2.
4. Ветви: (а) подписка — OAuth-бэкенд не тарифицирует за токен, `usd = 0`
   ожидаем; зафиксировать в `docs/opencode.md`, сравнение вести в токенах и
   задержке (паттерн qwen, `docs/opencode.md:37`); фиктивный `cost` не
   добавлять. (б) баг расчёта — сообщить пользователю с доказательствами;
   исправление на стороне OpenCode вне области harness. Конфиг-`cost`
   допустим только как явная оценка с согласия пользователя (семантика F2
   прошлого аудита: оценка по ценам конфига, не счёт провайдера).

### Шаг 5. Документация

Обновить `docs/opencode.md`: секция openai — переопределения моделей, потолок
8192, дешёвый тир 272 000, варианты и база low, семантика стоимости по итогу
шага 4. Комментарии в код не добавлять. Не коммитить без запроса пользователя.

## Приёмочные проверки

1. `install.sh --check` проходит; merged-конфиг сохраняет переопределения
   openai-моделей.
2. Список моделей отдаёт `limit.output = 8192`, `limit.input = 250000` для
   `gpt-6-sol` и `gpt-6.1-sol`.
3. Контрольные запросы `#low`/`#high`: `max_completion_tokens = 8192` в теле;
   `output + reasoning ≤ 8192`; принудительно длинная генерация завершается
   `finish = length` ровно на 8192.
4. Повторный префикс: `cacheRead > 0`, `cacheWrite = 0`.
5. F2 закрыт доказательствами: либо `usd > 0` по формуле каталога, либо
   задокументированная подписочная семантика.
6. Длинная сессия: compaction срабатывает до контекста 272 000 (дешёвый тир).
7. При правках кода: `node --test --test-concurrency=1 ai-hooks/test/test-*.mjs`.
8. В diff нет добавленных комментариев, секретов в Git, Codex CLI не
   установлен, чужие поля live-конфига не изменены.

## Приложение. Источники фактов

- Снимки: `~/.local/state/harness/optimize/opencode/90277afafe4bf1a0/sessions/*.json`,
  assistant-записи `sequence` с `model.providerID == "openai"`; jq-агрегация
  18.11 (n/input/output/reasoning/cacheRead/usd, разбивка по дням и версии
  клиента, failed/retry/compactionEvent).
- Каталог: `~/.cache/opencode/models.json` (mtime 01.11 15:58 МСК),
  `openai.models.gpt-6-sol / gpt-6.1-sol / gpt-6-luna`: cost, tiers,
  limit, reasoning_options.
- Конфиги: `opencode/opencode.jsonc:8-49` (паттерн deepseek, openai),
  `:62-68` (compaction), `:72-76` (plugins);
  `~/.config/opencode/opencode.jsonc:138-215` (openai: settings + disabled).
- Auth: `~/.local/share/opencode/opencode.db`, таблица `credential`
  (integration_id `openai`, active=1, создан 01.11 23:41 МСК, обновлён 18.11;
  секретные поля не читались); sqlite3 отсутствует, использован
  `node:sqlite` (Node v24.18.0).
- Переиспользование: `opencode/model-tuning.mjs:1-15`
  (`clampOutputCap`/`withMaxTokens`), `opencode/kimi-tuning/tuning.mjs:1-26` и
  `index.ts:1-21` (паттерн `provider.transform`), `docs/opencode.md:5,37,39`.
- Индекс: `tokensave sync` 18.11 (0 изменений, stale_commits был 1);
  `.jsonc` не индексируется (подтверждено выводом sync) — локальное чтение
  конфигов оправдано.
