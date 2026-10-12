#!/usr/bin/env node
// Claude Code, PreToolUse (mcp__tokensave__*): угаданные имена параметров
// tokensave — в настоящие, через updatedInput.
// Адаптер: формат хука Claude ↔ ядро tool-args-core.mjs:normalizeToolInput.

import { normalizeToolInput } from '../tool-args-core.mjs';
import { isEntryPoint } from '../state-core.mjs';
import { runHook } from './hook-io.mjs';

export function check(input) {
  const fixed = normalizeToolInput(input.tool_name, input.tool_input);
  if (fixed === input.tool_input) return null;
  return { updatedInput: fixed, reason: 'имена параметров tokensave' };
}

if (isEntryPoint(import.meta.url)) runHook(check, 'PreToolUse');
