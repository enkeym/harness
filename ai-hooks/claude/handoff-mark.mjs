#!/usr/bin/env node
// Claude Code, PostToolUse (ExitPlanMode): план одобрен. Если это снимок handoff,
// контекст при этом мог не очиститься (диалог в Remote Control) — ставим метку,
// по которой следующая сессия корня получит снимок (handoff-pickup).
// Адаптер: формат хука Claude ↔ ядро handoff-core.mjs:markPending.

import { markPending, planOf } from '../handoff-core.mjs';
import { isEntryPoint } from '../state-core.mjs';
import { runHook } from './hook-io.mjs';

export function check(input) {
  if (input.tool_name !== 'ExitPlanMode' || !input.cwd) return null;
  const ti = input.tool_input || {};
  const planPath = ti.planFilePath || input.tool_response?.filePath;
  markPending({ cwd: input.cwd, sessionId: input.session_id, planPath, plan: planOf({ ...ti, planFilePath: planPath }) });
  return null;
}

if (isEntryPoint(import.meta.url)) runHook(check, 'PostToolUse');
