#!/usr/bin/env node
// Claude Code, UserPromptSubmit: промпт в сессии, что пометила снимок handoff, —
// работу продолжили здесь, метка для следующей сессии не нужна.
// Адаптер: формат хука Claude ↔ ядро handoff-core.mjs:dropPending.

import { dropPending } from '../handoff-core.mjs';
import { isEntryPoint } from '../state-core.mjs';
import { runHook } from './hook-io.mjs';

export function check(input) {
  if (input.cwd && input.session_id) dropPending(input.cwd, input.session_id);
  return null;
}

if (isEntryPoint(import.meta.url)) runHook(check, 'UserPromptSubmit');
