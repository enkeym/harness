#!/usr/bin/env node
// Claude Code, SessionStart: новая сессия начинается с режима по умолчанию.
//
// Решение каталога (/ask, /ask-off) живёт до конца сессии — как встроенные
// режимы, а не как настройка проекта. Сбрасываем только на старте и на /clear:
// на resume и compact сессия продолжается, и менять режим под руками нельзя.

import { resetMode } from '../ask-core.mjs';

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => { raw += c; });
process.stdin.on('end', () => {
  let input;
  try { input = JSON.parse(raw); } catch { process.exit(0); }
  if (input.source === 'startup' || input.source === 'clear') {
    try { resetMode(input.cwd); } catch { /* не сбросили — режим просто останется прежним */ }
  }
  process.exit(0);
});
