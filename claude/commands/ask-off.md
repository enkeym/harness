---
description: Выключить ask mode на эту сессию — вернуть правки файлов
allowed-tools: Bash(node ~/.ai-hooks/bin/ask-mode.mjs:*)
---

!`node ~/.ai-hooks/bin/ask-mode.mjs off`

Ask mode выключен для этой сессии — правки снова разрешены.
Новая сессия стартует в режиме по умолчанию (`ask-mode.mjs default`); включить
снова — `/ask`. Подтверди одной строкой, без разбора кода.
