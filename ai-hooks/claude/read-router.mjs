#!/usr/bin/env node
// Claude Code, PreToolUse (Read): файл из индекса tokensave читают
// tokensave_body/tokensave_read, а не Read целиком.
// Адаптер: формат хука Claude ↔ ядро guard-core.mjs:guardRead.
// Срабатывает ТОЛЬКО для файлов, которые есть в индексе tokensave.

import { guardRead, CLAUDE_LABELS } from '../guard-core.mjs';
import { isEntryPoint } from '../state-core.mjs';
import { runHook } from './hook-io.mjs';

export function check(input) {
  const ti = input.tool_input || {};
  const reason = input.tool_name === 'Read'
    ? guardRead(ti.file_path || ti.path || '', input.cwd, CLAUDE_LABELS, input.session_id)
    : null;
  return reason ? { decision: 'deny', reason } : null;
}

if (isEntryPoint(import.meta.url)) runHook(check, 'PreToolUse');
