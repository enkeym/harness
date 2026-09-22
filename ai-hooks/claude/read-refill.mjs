#!/usr/bin/env node
// Claude Code, PostToolUse на mcp__tokensave__tokensave_read: заглушку
// `unchanged: true` из межсессионного кэша tokensave заменяет текстом файла с
// диска через updatedToolOutput. Логика — read-core.mjs.
//
// Не гард: ничего не запрещает. Молчит, когда ответ не заглушка, режим map или
// signatures, чтение чужой ветки. Любая ошибка → выход без вывода: агент
// получит заглушку, как и без хука.

import { refillResponse } from '../read-core.mjs';

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => { raw += c; });
process.stdin.on('end', () => {
  try {
    const input = JSON.parse(raw);
    // Порядок как у bin/mcp-serve.sh: сервер стартует от каталога сессии.
    const start = process.env.CLAUDE_PROJECT_DIR || input.cwd || process.cwd();
    const updated = refillResponse(input.tool_response, input.tool_input, start);
    if (updated) {
      process.stdout.write(JSON.stringify({
        hookSpecificOutput: { hookEventName: 'PostToolUse', updatedToolOutput: updated },
      }));
    }
  } catch {
    // без подмены агент получит заглушку — не повод ломать ход
  }
  process.exit(0);
});
