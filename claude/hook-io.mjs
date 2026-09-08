// Общий ввод/вывод PreToolUse-хуков Claude Code: разбор stdin, формат ответа,
// предохранитель от повторных запретов. Три роутера (edit, read/search, bash)
// отличаются только тем, какую функцию guard-core они зовут.

import { breakerAllows, denialKey } from '../guard-core.mjs';

// tokensave падает не на одном файле, а на всём графе (MCP на чужой ветке, лок
// БД, смена схемы). Раз повтор случился — гасим первый отказ и для соседних
// целей того же класса, иначе агент собирает по отказу на каждый файл.
const GUARD_FAMILY = {
  Read: 'read', Grep: 'read',
  Edit: 'edit', Write: 'edit',
  Bash: 'bash', mcp__ide__executeCode: 'bash',
};

// Ошибка разбора stdin → пропускаем вызов: хук не должен ломать работу агента.
export function readInput(cb) {
  let raw = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (c) => { raw += c; });
  process.stdin.on('end', () => {
    let input;
    try { input = JSON.parse(raw); } catch { process.exit(0); }
    cb(input);
  });
}

function finish(payload) {
  if (payload) process.stdout.write(JSON.stringify(payload));
  process.exit(0);
}

// reason === null → вызов разрешён. Иначе запрет, но только первый на эту цель
// (и на соседние того же класса, если повтор уже случился): альтернативы у
// агента нет, и второй отказ даёт цикл вместо результата.
export function respond(input, reason) {
  if (!reason) finish(null);

  // Без session_id предохранителю не на что опираться (так гарды зовёт тест-
  // харнес): считать разные прогоны одной сессией — значит терять запреты.
  const key = denialKey(input.tool_name, input.tool_input);
  const family = GUARD_FAMILY[input.tool_name] || null;
  if (input.session_id && breakerAllows(input.session_id, key, family)) {
    finish({
      systemMessage:
        `tokensave-гард: ${input.tool_name} пропущен — у tokensave нет рабочего ответа ` +
        '(частая причина — MCP-сервер остался на родительской ветке графа: ' +
        'переподключи /mcp, сверься с tokensave_status).',
    });
  }

  finish({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  });
}
