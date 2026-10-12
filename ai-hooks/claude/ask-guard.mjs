#!/usr/bin/env node
// Claude Code, PreToolUse (все инструменты): в ask mode запрещено всё, что
// меняет файлы или состояние снаружи. Режим выключен → хук молчит.

import { isOn, askGuard, ASK_DENY_HINT } from '../ask-core.mjs';
import { isEntryPoint } from '../state-core.mjs';
import { runHook } from './hook-io.mjs';

export function check(input) {
  if (!isOn(input.cwd, input.session_id)) return null;
  const what = askGuard(input.tool_name, input.tool_input);
  return what ? { decision: 'deny', reason: `Запрещено в ask mode: ${what}. ${ASK_DENY_HINT}` } : null;
}

if (isEntryPoint(import.meta.url)) runHook(check, 'PreToolUse');
