# Compaction cost baseline (до `agents.compaction.model`)

Статус: baseline снят до изменения конфигурации. Дата: 2026-11-07. OpenCode 2.2.6.
Источник: записи harness `~/.local/state/harness/optimize/opencode/*/sessions/*.json`
(`schemaVersion` 2), поле `nativeReportedUSD` по шагам `type=compaction`.
Это native-оценка OpenCode по статическим cost-блокам, не billing провайдера.

## 1. Компактации по дням и моделям

| Дата | Модель | Компактаций | Сумма USD | Средняя USD | Input-токены |
| --- | --- | ---: | ---: | ---: | ---: |
| 2026-11-01 | deepseek-flash | 2 | 0.0000 | 0.0000 | 19 135 |
| 2026-11-02 | deepseek-flash | 25 | 0.1552 | 0.0062 | 915 028 |
| 2026-11-03 | deepseek-flash | 67 | 1.9585 | 0.0292 | 5 826 968 |
| 2026-11-03 | deepseek-v4-pro | 6 | 0.7280 | 0.1213 | 521 565 |
| 2026-11-03 | apimira/qwen3.8-max | 1 | 0.0000 | 0.0000 | 6 |
| 2026-11-03 | (модель не записана) | 5 | 0.0000 | 0.0000 | 0 |
| 2026-11-04 | deepseek-flash | 13 | 0.3878 | 0.0298 | 1 175 256 |
| 2026-11-05 | deepseek-flash | 41 | 0.9768 | 0.0238 | 2 904 590 |
| 2026-11-06 | deepseek-flash | 35 | 0.9087 | 0.0260 | 2 675 684 |
| 2026-11-07 | deepseek-flash | 1 | 0.0374 | 0.0374 | 112 346 |
| 2026-11-07 | deepseek-v4-pro | 1 | 0.1371 | 0.1371 | 98 842 |

## 2. Доля компактаций в дневном native-расходе

| Дата | assistant USD | compaction USD | Доля |
| --- | ---: | ---: | ---: |
| 2026-11-01 | 0.0527 | 0.0000 | 0.0% |
| 2026-11-02 | 2.3947 | 0.1552 | 6.1% |
| 2026-11-03 | 10.5150 | 2.6865 | 20.4% |
| 2026-11-04 | 1.9394 | 0.3878 | 16.7% |
| 2026-11-05 | 3.9265 | 0.9768 | 19.9% |
| 2026-11-06 | 2.4867 | 0.9087 | 26.8% |
| 2026-11-07 | 1.0117 | 0.1746 | 14.7% |

## 3. Что меняется

Единственная правка глобального конфига:

```jsonc
"agents": {
  "compaction": { "model": "deepseek/deepseek-flash" }
}
```

Не меняются: `compaction.buffer` (30000), `compaction.keep.tokens` (20000),
`compaction.auto`, тарифы и `peakWindowsUTC`, `dailyNativeUSD`, модели
`plan`/`ask`/`build`, reasoning settings, `experimental.background_compaction`.

Ожидаемый эффект без подтверждения: компактация в Pro-сессии перестаёт
наследовать Pro. Оценка по 2026-11-07: Pro-компактация `0.1371` → Flash ≈ `0.0316`.
По 2026-11-03: 6 Pro-компактаций `0.7280` → ≈ `0.19`.

## 4. Протокол сравнения (через два дня)

Считать той же выборкой и тем же методом:

```js
// node, из ~/.local/state/harness/optimize/opencode
const fs = require("fs"), path = require("path")
const files = []
for (const d of fs.readdirSync(".")) {
  const sd = path.join(d, "sessions")
  if (fs.existsSync(sd)) for (const f of fs.readdirSync(sd)) if (f.endsWith(".json")) files.push(path.join(sd, f))
}
const agg = {}
for (const f of files) {
  const r = JSON.parse(fs.readFileSync(f, "utf8"))
  for (const s of r.sequence ?? []) {
    if (s.type !== "compaction") continue
    const day = new Date(s.time?.created ?? 0).toISOString().slice(0, 10)
    const model = s.model ? `${s.model.providerID}/${s.model.id}` : "?"
    const k = `${day} | ${model}`
    const a = (agg[k] ??= { n: 0, cost: 0, inp: 0 })
    a.n++; a.cost += s.nativeReportedUSD ?? 0; a.inp += s.tokens?.input ?? 0
  }
}
for (const k of Object.keys(agg).sort()) console.log(k, `n=${agg[k].n} cost=${agg[k].cost.toFixed(4)} in=${agg[k].inp}`)
```

Метрики сравнения:

1. Число и суммарная стоимость компактаций на модель (доля Pro-компактаций должна стать 0).
2. Доля compaction в дневном native-расходе.
3. Средний input компактации: не должен резко вырасти (иначе компактация слишком велика).
4. Качество: сохранность инструкций/решений/файлов/состояния задачи после компактации
   (проверка `task-context` restore, `session.compaction.ended`, отсутствие повторной
   потери контекста и повторных чтений).
5. Сверка с billing-файлом DeepSeek за те же дни; native-оценка не считается billing.

## 5. Ограничения вывода

- Выводы только по фактическим данным за окно наблюдения; экономия не считается
  подтверждённой до сверки.
- Разные дни несопоставимы по объёму работы: сравнивать долю и среднюю стоимость,
  а не абсолютную сумму.

## 6. Результаты после изменения (2026-11-07)

Диф применялся в 21:16:52 MSK. Первая реальная компактация после изменения
стартовала в 21:17:39 MSK в Flash-сессии `ses_e48cd088bffe6VykuC8mnrqQ6M`
и завершилась (`status=completed`) с моделью `deepseek/deepseek-flash`.

| Поле | Значение |
| --- | --- |
| Модель | `deepseek/deepseek-flash` |
| Input (cache-miss) | 107 651 |
| cacheRead | 4 992 (hit 4.4%) |
| Output | 2 238 |
| Reasoning | 0 |
| native USD | 0.035010852 |

Интерпретация: компактация прошла штатно, cache-профиль (hit 4–6%) совпадает
с историческими компактациями, то есть смена модели не изменила поведение
кэша. Сессия уже использовала Flash, поэтому событие не доказывает
переопределение модели в Pro-сессии — эта проверка остаётся неподтверждённой.

Наблюдение harness на момент старта хранило запись как `running` с
`model: null`. Синхронизация `node bin/opencode-observe.mjs ses_e48cd088bffe6VykuC8mnrqQ6M`
обновила ту же запись по `id`: `request.model=deepseek/deepseek-flash`,
`status=completed`, токены и стоимость совпали с живым API; gap
`auxiliary-usage-missing` закрылся.

### Вторая компактация (21:22:15 MSK)

Та же Flash-сессия, `status=completed`, модель `deepseek/deepseek-flash`:
input 93 887, cacheRead 5 120 (hit 5.2%), output 2 567, reasoning 0,
native USD 0.03127722.

Итого после изменения: 2 компактации, обе на Flash, `$0.0663`, средний input
100 769, средний hit 4.8%. Pro-сессия `ses_e48d70a44fferOp4mg9nYLUbgF` после
правки не компактировалась (последняя активность 18:07 UTC, до изменения),
поэтому переопределение модели в Pro-сессии runtime-не подтверждено.
Специально провоцировать её компактацию нельзя: это искусственный платный
запрос.
