#!/usr/bin/env node
// Claude Code, UserPromptSubmit: не пустить в контекст промпт длиннее предела.
//
// Счётчик контекста (context-meter, context-step) видит окно уже после того,
// как вставка в него попала — а вернуть её нельзя, она оплачивается каждым
// ходом до конца сессии. Единственная точка, где дамп можно остановить, — до
// отправки: decision 'block' стирает промпт, reason показывается пользователю
// и в контекст не идёт.
//
// Предел и текст — в context-core (PASTE_LIMIT, oversizedPrompt): те же
// пороги, тот же файл, что и у остальных замеров контекста.

import { oversizedPrompt } from '../context-core.mjs';

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => { raw += c; });
process.stdin.on('end', () => {
  try {
    const reason = oversizedPrompt(JSON.parse(raw).prompt);
    if (reason) process.stdout.write(JSON.stringify({ decision: 'block', reason }));
  } catch { /* предохранитель не должен ломать ход */ }
  process.exit(0);
});
