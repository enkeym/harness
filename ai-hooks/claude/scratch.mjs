#!/usr/bin/env node
// Claude Code: уборка черновиков агента в /tmp (../scratch-core.mjs). Два
// события в одном хуке — PreToolUse Bash|Write запоминает пути, которых ещё
// нет, SessionEnd (/clear, выход) удаляет созданное. Всегда молчит и всегда
// пропускает.

import { recordScratch, removeScratch } from '../scratch-core.mjs';
import { readInput } from './hook-io.mjs';

readInput((input) => {
  const sid = input.session_id;
  if (input.hook_event_name === 'SessionEnd') removeScratch(sid);
  else recordScratch(sid, input.tool_name, input.tool_input);
  process.exit(0);
});
