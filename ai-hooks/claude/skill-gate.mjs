#!/usr/bin/env node
// Claude Code, PreToolUse (Edit|Write|MultiEdit|NotebookEdit|Bash и правки
// tokensave: str_replace, multi_str_replace, insert_at): запрет
// действия, для которого CLAUDE.md требует скилл, а он в этой сессии не
// загружен. Какие действия и какие скиллы — GATES в skill-core. Метку ставит
// skill-track. Fail-open: без session_id или при ошибке состояния — пропуск.
// Со скиллами — ещё сообщение коммита: без пустой строки после заголовка
// запрет, иначе его чинят amend и force push. И diff: коммит ждёт чтения
// `git diff` позже последней правки — отметки правки и чтения ставятся здесь же,
// вызовы субагента их не ставят: он читал, а не основная сессия.

import { gateEnabled, loadedSkills, missingSkills, denyReason, commitMessageProblem, unreadDiff, readsDiff, editsFile, markWork } from '../skill-core.mjs';
import { isEntryPoint } from '../state-core.mjs';
import { runHook } from './hook-io.mjs';

export function check(input) {
  if (!input.session_id || !gateEnabled()) return null;
  const gap = missingSkills(input.tool_name, input.tool_input, loadedSkills(input.session_id), input.cwd);
  if (gap) return { decision: 'deny', reason: denyReason(gap) };
  const cmd = input.tool_name === 'Bash' ? input.tool_input?.command : null;
  const msg = cmd ? commitMessageProblem(cmd) || unreadDiff(input.session_id, cmd) : null;
  if (msg) return { decision: 'deny', reason: msg };
  if (!input.agent_id) {
    if (editsFile(input.tool_name, input.tool_input, input.cwd)) markWork(input.session_id, 'edit');
    if (readsDiff(cmd)) markWork(input.session_id, 'diff');
  }
  return null;
}

if (isEntryPoint(import.meta.url)) runHook(check, 'PreToolUse');
