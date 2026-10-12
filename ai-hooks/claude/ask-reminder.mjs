#!/usr/bin/env node
// Claude Code, UserPromptSubmit: в ask mode добавляет к промпту правило режима.
// Без этого агент узнаёт об ограничении только из отказа гарда — то есть после
// того, как уже собрался править файл.

import { isOn, ASK_DENY_HINT } from '../ask-core.mjs';
import { isEntryPoint } from '../state-core.mjs';
import { runHook } from './hook-io.mjs';

export function check(input) {
  return isOn(input.cwd, input.session_id) ? { context: ASK_DENY_HINT } : null;
}

if (isEntryPoint(import.meta.url)) runHook(check, 'UserPromptSubmit');
