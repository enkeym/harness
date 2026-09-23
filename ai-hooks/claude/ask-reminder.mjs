#!/usr/bin/env node
// Claude Code, UserPromptSubmit: в ask mode добавляет к промпту правило режима.
// Без этого агент узнаёт об ограничении только из отказа гарда — то есть после
// того, как уже собрался править файл.

import { isOn, ASK_DENY_HINT } from '../ask-core.mjs';

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => { raw += c; });
process.stdin.on('end', () => {
  let input;
  try { input = JSON.parse(raw); } catch { process.exit(0); }
  if (!isOn(input.cwd, input.session_id)) process.exit(0);

  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'UserPromptSubmit',
      additionalContext: ASK_DENY_HINT,
    },
  }));
  process.exit(0);
});
