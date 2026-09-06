#!/usr/bin/env node
// Claude Code, PreToolUse (Read|Grep): чтение/поиск проиндексированного кода → только tokensave.
// Адаптер: формат хука Claude ↔ общее ядро guard-core.mjs.
// Срабатывает ТОЛЬКО для файлов, которые есть в индексе tokensave.

import { guardRead, guardGrep, CLAUDE_LABELS } from '../guard-core.mjs';
import { readInput, respond } from './hook-io.mjs';

readInput((input) => {
  const ti = input.tool_input || {};
  const cwd = input.cwd;
  let reason = null;

  switch (input.tool_name) {
    case 'Read':
      reason = guardRead(ti.file_path || ti.path || '', cwd, CLAUDE_LABELS);
      break;
    case 'Grep':
      reason = guardGrep({ path: ti.path, glob: ti.glob, type: ti.type }, cwd, CLAUDE_LABELS);
      break;
  }

  respond(input, reason);
});
