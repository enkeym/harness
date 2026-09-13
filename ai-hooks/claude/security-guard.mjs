#!/usr/bin/env node
// Claude Code, PreToolUse (*): гард безопасности.
// Адаптер: формат хука Claude ↔ ядро security-core.mjs.
//
// Предохранителя нет: в отличие от гардов tokensave, здесь запрет говорит не
// «возьми другой инструмент», а «у этого действия есть последствия». Пропускать
// повторный вызов значило бы отменять запрет вторым нажатием.

import { securityGuard, DENY } from '../security-core.mjs';
import { readInput, decide } from './hook-io.mjs';

readInput((input) => {
  let verdict = null;
  try {
    verdict = securityGuard(input.tool_name, input.tool_input);
  } catch {
    verdict = null; // fail-open: гард не должен ломать работу
  }

  if (!verdict) decide(input, null);

  decide(
    input,
    verdict.level,
    (verdict.level === DENY ? 'security-guard, запрет: ' : 'security-guard: ') + verdict.reason,
  );
});
