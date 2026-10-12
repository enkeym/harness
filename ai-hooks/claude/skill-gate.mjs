#!/usr/bin/env node
// Claude Code, PreToolUse (Edit|Write|MultiEdit|NotebookEdit|Bash и правки
// tokensave: str_replace, multi_str_replace, insert_at): запрет
// действия, для которого CLAUDE.md требует скилл, а он в этой сессии не
// загружен. Какие действия и какие скиллы — GATES в skill-core. Метку ставит
// skill-track. Fail-open: без session_id или при ошибке состояния — пропуск.
// Со скиллами — ещё сообщение коммита: без пустой строки после заголовка
// запрет, иначе его чинят amend и force push.

import { gateEnabled, loadedSkills, missingSkills, denyReason, commitMessageProblem } from '../skill-core.mjs';
import { isEntryPoint } from '../state-core.mjs';
import { runHook } from './hook-io.mjs';

export function check(input) {
  if (!input.session_id || !gateEnabled()) return null;
  const gap = missingSkills(input.tool_name, input.tool_input, loadedSkills(input.session_id), input.cwd);
  if (gap) return { decision: 'deny', reason: denyReason(gap) };
  const msg = input.tool_name === 'Bash' ? commitMessageProblem(input.tool_input?.command) : null;
  return msg ? { decision: 'deny', reason: msg } : null;
}

if (isEntryPoint(import.meta.url)) runHook(check, 'PreToolUse');
