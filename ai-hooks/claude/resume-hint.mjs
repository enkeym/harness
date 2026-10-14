#!/usr/bin/env node
// Claude Code, SessionStart (resume): открыли звено цепочки handoff, а работа
// продолжилась в следующем. Пользователю — systemMessage с командой /resume,
// модели — то же в additionalContext, чтобы не отрицала сделанное там.
// Адаптер: формат хука Claude ↔ ядро handoff-core.mjs:resumeHint.

import { resumeHint } from '../handoff-core.mjs';
import { isEntryPoint } from '../state-core.mjs';
import { readInput, finish } from './hook-io.mjs';

export function check(input) {
  if (input.source !== 'resume' || !input.transcript_path) return null;
  return resumeHint(input.transcript_path);
}

// Падение внутри check ловит readInput: crash в журнал, старт не ломается.
if (isEntryPoint(import.meta.url)) {
  readInput((input) => {
    const hint = check(input);
    finish(hint && {
      systemMessage: hint.message,
      hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: hint.context },
    });
  });
}
