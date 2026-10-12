#!/usr/bin/env node
// Claude Code: метка «скилл загружен» для skill-gate. Два события в одном
// хуке — PreToolUse инструмента Skill (модель грузит сама) и UserPromptSubmit
// с промптом `/name` (пользовательский вызов через Skill не проходит и без
// этой ветки гейт запрещал бы правку сразу после того, как пользователь сам
// открыл скилл). Всегда молчит и всегда пропускает.

import { markLoaded } from '../skill-core.mjs';
import { isEntryPoint } from '../state-core.mjs';
import { runHook } from './hook-io.mjs';

const PROMPT_SKILL_RE = /^\s*\/([a-z0-9][a-z0-9:_/-]*)/i;

export function check(input) {
  const sid = input.session_id;
  if (!sid) return null;
  if (input.tool_name === 'Skill') {
    markLoaded(sid, input.tool_input?.skill);
  } else if (typeof input.prompt === 'string') {
    const m = PROMPT_SKILL_RE.exec(input.prompt);
    if (m) markLoaded(sid, m[1]);
  }
  return null;
}

if (isEntryPoint(import.meta.url)) runHook(check, 'PreToolUse');
