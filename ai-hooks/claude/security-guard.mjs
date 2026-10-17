#!/usr/bin/env node
// Claude Code, PreToolUse (*): гард безопасности.
// Адаптер: формат хука Claude ↔ ядро security-core.mjs.
//
// Предохранителя нет: в отличие от гардов tokensave, здесь запрет говорит не
// «возьми другой инструмент», а «у этого действия есть последствия». Пропускать
// повторный вызов значило бы отменять запрет вторым нажатием.
//
// ask, чью категорию пользователь назвал в последнем промпте транскрипта
// (grant-core.mjs), не задаётся: в hooks.jsonl уходит строка `granted` с категорией — для аудита.

import { securityGuard, DENY } from '../security-core.mjs';
import { isGranted } from '../grant-core.mjs';
import { logDecision } from '../hooklog-core.mjs';
import { isEntryPoint } from '../state-core.mjs';
import { runHook, targetOf } from './hook-io.mjs';

export function check(input) {
  let verdict = null;
  const ctx = { isGranted: (cat) => isGranted(input.transcript_path, cat), granted: [] };
  try {
    verdict = securityGuard(input.tool_name, input.tool_input, ctx);
  } catch {
    verdict = null; // fail-open: гард не должен ломать работу
  }
  for (const g of ctx.granted) logDecision('granted', { target: targetOf(input), cat: g.cat, reason: g.reason });

  if (!verdict) return null;
  return {
    decision: verdict.level,
    reason: (verdict.level === DENY ? 'security-guard, запрет: ' : 'security-guard: ') + verdict.reason,
  };
}

if (isEntryPoint(import.meta.url)) runHook(check, 'PreToolUse');
