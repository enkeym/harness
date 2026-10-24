#!/usr/bin/env node
// Claude Code, SessionStart (startup|clear): в корне осталась метка снимка handoff,
// одобренного без очистки контекста, — отдаём путь снимка один раз. Пользователю
// после /clear хватает «продолжи».
// Адаптер: формат хука Claude ↔ ядро handoff-core.mjs:takePending.

import { takePending } from '../handoff-core.mjs';
import { isEntryPoint } from '../state-core.mjs';
import { readInput, finish } from './hook-io.mjs';

export function check(input) {
  if (!/^(startup|clear)$/.test(String(input.source)) || !input.cwd) return null;
  const planPath = takePending(input.cwd, input.session_id);
  if (!planPath) return null;
  return {
    message: `Передача handoff: снимок ${planPath} отдан новой сессии.`,
    context: `handoff-pickup: the previous session handed its task over without clearing the context. `
      + `The snapshot is @${planPath} — read it and continue from its "Дальше" section. `
      + 'If the user asks for something else, follow the user and ignore the snapshot.',
  };
}

if (isEntryPoint(import.meta.url)) {
  readInput((input) => {
    const pickup = check(input);
    finish(pickup && {
      systemMessage: pickup.message,
      hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: pickup.context },
    });
  });
}
