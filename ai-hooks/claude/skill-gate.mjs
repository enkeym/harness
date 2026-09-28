#!/usr/bin/env node
// Claude Code, PreToolUse (Edit|Write|MultiEdit|NotebookEdit|Bash и правки
// tokensave: str_replace, multi_str_replace, insert_at): запрет
// действия, для которого CLAUDE.md требует скилл, а он в этой сессии не
// загружен. Какие действия и какие скиллы — GATES в skill-core. Метку ставит
// skill-track. Fail-open: без session_id или при ошибке состояния — пропуск.

import { gateEnabled, loadedSkills, missingSkills, denyReason } from '../skill-core.mjs';
import { readInput, decide } from './hook-io.mjs';

readInput((input) => {
  if (!input.session_id || !gateEnabled()) decide(input, null);
  const gap = missingSkills(input.tool_name, input.tool_input, loadedSkills(input.session_id), input.cwd);
  decide(input, gap ? 'deny' : null, gap ? denyReason(gap) : null);
});
