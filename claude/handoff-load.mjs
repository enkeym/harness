#!/usr/bin/env node
// Claude Code, SessionStart (startup|clear): подставить передачу от прошлой
// сессии, если она есть и не протухла.
//
// Смысл — сделать `/clear` дешёвой операцией: контекст выбрасывается, состояние
// работы возвращается из файла. Хук ничего не решает, он только подаёт файл;
// что с ним делать, сказано в CLAUDE.md.

import { handoffContext } from '../handoff-core.mjs';

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => { raw += c; });
process.stdin.on('end', () => {
  try {
    const input = JSON.parse(raw);
    const context = handoffContext(input.cwd);
    if (context) {
      process.stdout.write(JSON.stringify({
        hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: context },
      }));
    }
  } catch { /* передача не должна ломать старт сессии */ }
  process.exit(0);
});
