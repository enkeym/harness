#!/usr/bin/env node
// Claude Code, PreToolUse (все инструменты): в ask mode запрещено всё, что
// меняет файлы или состояние снаружи. Режим выключен → хук молчит.

import { isOn, askGuard, ASK_DENY_HINT } from '../ask-core.mjs';

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => { raw += c; });
process.stdin.on('end', () => {
  let input;
  try { input = JSON.parse(raw); } catch { process.exit(0); }

  if (!isOn(input.cwd)) process.exit(0);

  const what = askGuard(input.tool_name, input.tool_input);
  if (!what) process.exit(0);

  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: `Запрещено в ask mode: ${what}. ${ASK_DENY_HINT}`,
    },
  }));
  process.exit(0);
});
