#!/usr/bin/env node
// Claude Code, PreToolUse (*): гард безопасности.
// Адаптер: формат хука Claude ↔ ядро security-core.mjs.
//
// Предохранителя нет: в отличие от гардов tokensave, здесь запрет говорит не
// «возьми другой инструмент», а «у этого действия есть последствия». Пропускать
// повторный вызов значило бы отменять запрет вторым нажатием.

import { securityGuard, DENY } from '../security-core.mjs';
import { readInput } from './hook-io.mjs';

readInput((input) => {
  let verdict = null;
  try {
    verdict = securityGuard(input.tool_name, input.tool_input);
  } catch {
    verdict = null; // fail-open: гард не должен ломать работу
  }

  if (!verdict) process.exit(0);

  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: verdict.level,
      permissionDecisionReason:
        (verdict.level === DENY ? 'security-guard, запрет: ' : 'security-guard: ') + verdict.reason,
    },
  }));
  process.exit(0);
});
