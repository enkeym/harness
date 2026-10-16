#!/usr/bin/env node
// Claude Code, PreToolUse (*): гард безопасности.
// Адаптер: формат хука Claude ↔ ядро security-core.mjs.
//
// Предохранителя нет: в отличие от гардов tokensave, здесь запрет говорит не
// «возьми другой инструмент», а «у этого действия есть последствия». Пропускать
// повторный вызов значило бы отменять запрет вторым нажатием.

import { securityGuard, DENY } from '../security-core.mjs';
import { isEntryPoint } from '../state-core.mjs';
import { runHook } from './hook-io.mjs';

export function check(input) {
  let verdict = null;
  try {
    verdict = securityGuard(input.tool_name, input.tool_input);
  } catch {
    verdict = null; // fail-open: гард не должен ломать работу
  }

  if (!verdict) return null;
  return {
    decision: verdict.level,
    reason: (verdict.level === DENY ? 'security-guard, запрет: ' : 'security-guard: ') + verdict.reason,
  };
}

if (isEntryPoint(import.meta.url)) runHook(check, 'PreToolUse');
