#!/usr/bin/env node
// Claude Code, PreToolUse (Bash|mcp__ide__executeCode): shell и исполнение кода
// не должны подменять tokensave на проиндексированных файлах.
// Адаптер: формат хука Claude ↔ общее ядро guard-core.mjs.
// Срабатывает ТОЛЬКО когда команда обращается к файлу из индекса tokensave.

import { guardBash, guardExec, CLAUDE_LABELS } from '../guard-core.mjs';
import { isEntryPoint } from '../state-core.mjs';
import { runHook } from './hook-io.mjs';

export function check(input) {
  const ti = input.tool_input || {};
  const cwd = input.cwd;
  let reason = null;

  switch (input.tool_name) {
    case 'Bash':
      reason = guardBash(ti.command || '', cwd, CLAUDE_LABELS);
      break;
    case 'mcp__ide__executeCode':
      reason = guardExec(ti.code || '', cwd, CLAUDE_LABELS);
      break;
  }

  return reason ? { decision: 'deny', reason } : null;
}

if (isEntryPoint(import.meta.url)) runHook(check, 'PreToolUse');
