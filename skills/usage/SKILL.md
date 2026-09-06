---
name: usage
description: Отчёт по расходу токенов, оценке стоимости, инструментам и субагентам из локального учёта ~/.ai-hooks/logs/usage.jsonl (пишется хуком Stop). Вызывается пользователем как /usage [--days N | --today | --project имя | --sessions].
disable-model-invocation: true
allowed-tools: Bash(node /home/enkeym/.ai-hooks/bin/usage-report.mjs:*), Bash(tokensave cost:*)
argument-hint: [--days N | --today | --project <имя> | --sessions]
---

# /usage

Два источника, оба показывай дословно, без пересказа.

1. Встроенный учёт tokensave — по всем агентам на машине, с долей попаданий в
   кэш. Диапазон: `today`, `7d`, `30d`, `month`, `all`.

```
tokensave cost 7d --by-model
```

2. Свой отчёт — разбивка по проектам, инструментам и субагентам, которой у
   tokensave нет:

```
node /home/enkeym/.ai-hooks/bin/usage-report.mjs $ARGUMENTS
```

Обе стоимости — оценка, а не счёт подписки, и они расходятся: свой отчёт
считает по текущему прайсу за миллион токенов (`PRICES` в
`~/.ai-hooks/claude/usage-log.mjs`), tokensave — по своему. Смотри на
пропорции между моделями, проектами и сессиями, не на абсолютную цифру.
Если стоит добавить наблюдение («субагенты съели половину», «кэш не
попадает»), одно предложение после вывода, не больше.
