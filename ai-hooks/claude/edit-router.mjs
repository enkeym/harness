#!/usr/bin/env node
// Claude Code, PreToolUse (Edit|Write): изменение исходного КОДА → только tokensave write-tools.
// Адаптер: формат хука Claude ↔ общее ядро guard-core.mjs.
// Создание НОВОГО файла через Write разрешено — tokensave не создаёт файлы.

import { guardEdit, CLAUDE_LABELS } from '../guard-core.mjs';
import { readInput, respond } from './hook-io.mjs';

readInput((input) => {
  const ti = input.tool_input || {};
  respond(input, guardEdit(ti.file_path || ti.path || '', input.cwd, CLAUDE_LABELS));
});
