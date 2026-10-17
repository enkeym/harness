#!/usr/bin/env node
// Claude Code, UserPromptSubmit: действия, которые пользователь назвал в
// промпте, — разрешения для security-guard до следующего промпта.
// Словарь и состояние — в grant-core.mjs.

import { recordGrants } from '../grant-core.mjs';
import { isEntryPoint } from '../state-core.mjs';
import { runHook } from './hook-io.mjs';

export function check(input) {
  recordGrants(input.session_id, input.prompt);
  return null;
}

if (isEntryPoint(import.meta.url)) runHook(check, 'UserPromptSubmit');
