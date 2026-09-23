#!/usr/bin/env node
// Claude Code, PreToolUse (все инструменты): в ask mode запрещено всё, что
// меняет файлы или состояние снаружи. Режим выключен → хук молчит.

import { isOn, askGuard, ASK_DENY_HINT } from '../ask-core.mjs';
import { readInput, decide } from './hook-io.mjs';

readInput((input) => {
  if (!isOn(input.cwd, input.session_id)) decide(input, null);

  const what = askGuard(input.tool_name, input.tool_input);
  if (!what) decide(input, null);

  decide(input, 'deny', `Запрещено в ask mode: ${what}. ${ASK_DENY_HINT}`);
});
