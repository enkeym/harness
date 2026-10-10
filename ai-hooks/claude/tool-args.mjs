#!/usr/bin/env node
// Claude Code, PreToolUse (mcp__tokensave__*): угаданные имена параметров
// tokensave — в настоящие, через updatedInput.
// Адаптер: формат хука Claude ↔ ядро tool-args-core.mjs:normalizeToolInput.

import { normalizeToolInput } from '../tool-args-core.mjs';
import { readInput, rewrite, respond } from './hook-io.mjs';

readInput((input) => {
  const fixed = normalizeToolInput(input.tool_name, input.tool_input);
  if (fixed === input.tool_input) respond(input, null);
  rewrite(input, fixed, 'имена параметров tokensave');
});
