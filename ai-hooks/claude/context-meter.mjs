#!/usr/bin/env node
// Claude Code, UserPromptSubmit: один раз сказать агенту собрать блок передачи
// в чат, когда контекст дорос до порога.
//
// Скилл не умеет запускаться сам по счётчику токенов — триггер может дать только
// хук. Отсюда разделение: хук знает, КОГДА (порог из context-core), скилл знает,
// ЧТО собрать в блок; переносит блок в новую сессию и очищает контекст человек —
// файлов передача не создаёт, `/clear` программно не вызывается.
//
// UserPromptSubmit, а не Stop: additionalContext доезжает до модели именно здесь.
//
// Этот хук видит только границы ходов. Внутри одного хода окно растёт на сотни
// тысяч токенов — там считает `context-step.mjs` на PostToolUse, фаза 'step'.

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
