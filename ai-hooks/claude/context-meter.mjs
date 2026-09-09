#!/usr/bin/env node
// Claude Code, UserPromptSubmit: сказать агенту, что контекст пора передавать.
//
// Скилл не умеет запускаться сам по счётчику токенов — триггер может дать только
// хук. Отсюда разделение: хук знает, КОГДА (порог из context-core), скилл знает,
// ЧТО написать в передачу, а сам переход нажимает человек — `/clear` программно
// не вызывается.
//
// UserPromptSubmit, а не Stop: additionalContext доезжает до модели именно здесь,
// и раз на ход пользователя — достаточно, внутри одного хода окно так не растёт.

import { contextNotice } from '../context-core.mjs';

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => { raw += c; });
process.stdin.on('end', () => {
  try {
    const notice = contextNotice(JSON.parse(raw));
    if (notice) {
      process.stdout.write(JSON.stringify({
        hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: notice.text },
      }));
    }
  } catch { /* замер не должен ломать ход */ }
  process.exit(0);
});
