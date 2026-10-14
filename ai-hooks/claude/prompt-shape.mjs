#!/usr/bin/env node
// Claude Code, UserPromptSubmit: размытый промпт — напоминание о task-brief
// одной строкой контекста. Форма промпта — в prompt-core; скилл уже загружен
// в сессии — молчит, напоминать нечего.

import { isLoosePrompt, LOOSE_PROMPT_HINT } from '../prompt-core.mjs';
import { loadedSkills } from '../skill-core.mjs';
import { isEntryPoint } from '../state-core.mjs';
import { runHook } from './hook-io.mjs';

export function check(input) {
  if (!isLoosePrompt(input.prompt)) return null;
  if (input.session_id && loadedSkills(input.session_id).has('task-brief')) return null;
  return { context: LOOSE_PROMPT_HINT };
}

if (isEntryPoint(import.meta.url)) runHook(check, 'UserPromptSubmit');
