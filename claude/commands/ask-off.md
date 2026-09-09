---
description: Выключить ask mode на эту сессию — вернуть правки файлов
allowed-tools: Bash(node /home/enkeym/.ai-hooks/bin/ask-mode.mjs:*)
---

!`node /home/enkeym/.ai-hooks/bin/ask-mode.mjs off`

Ask mode выключен для этого каталога до конца сессии — правки снова разрешены.
Новая сессия стартует в режиме по умолчанию (`ask-mode.mjs default`); включить
снова — `/ask`. Подтверди одной строкой, без разбора кода.
