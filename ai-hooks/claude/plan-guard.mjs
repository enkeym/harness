#!/usr/bin/env node
// Claude Code, PreToolUse (ExitPlanMode): план, с которым стартует новая сессия,
// не длиннее предела и без наслоенных снимков handoff.
// Адаптер: формат хука Claude ↔ ядро context-core.mjs:oversizedPlan.
// Текст плана — в tool_input.plan; без него читаем planFilePath.

import fs from 'node:fs';
import { oversizedPlan } from '../context-core.mjs';
import { readInput, respond } from './hook-io.mjs';

function planText(ti) {
  if (typeof ti.plan === 'string') return ti.plan;
  try { return fs.readFileSync(ti.planFilePath, 'utf8'); } catch { return ''; }
}

readInput((input) => {
  const reason = input.tool_name === 'ExitPlanMode'
    ? oversizedPlan(planText(input.tool_input || {}))
    : null;
  respond(input, reason);
});
