#!/usr/bin/env node
// Claude Code: уборка черновиков агента в /tmp (../scratch-core.mjs). Три
// события в одном хуке — PreToolUse Bash|Write запоминает пути, которых ещё
// нет, Stop (конец хода) и SessionEnd (/clear, выход) удаляют созданное. Всегда молчит и всегда
// пропускает.

import { recordScratch, removeScratch } from '../scratch-core.mjs';
import { isEntryPoint } from '../state-core.mjs';
import { runHook } from './hook-io.mjs';

const END_EVENTS = new Set(['Stop', 'SessionEnd']);

export function check(input) {
  const sid = input.session_id;
  if (END_EVENTS.has(input.hook_event_name)) removeScratch(sid);
  else recordScratch(sid, input.tool_name, input.tool_input);
  return null;
}

if (isEntryPoint(import.meta.url)) runHook(check, 'PreToolUse');
