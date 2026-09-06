// Общий ввод/вывод PreToolUse-хуков Claude Code: разбор stdin, формат ответа,
// предохранитель от повторных запретов. Три роутера (edit, read/search, bash)
// отличаются только тем, какую функцию guard-core они зовут.

import { breakerAllows, denialKey } from '../guard-core.mjs';

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

// reason === null → вызов разрешён. Иначе запрет, но только первый на эту цель:
// повторный тот же вызов означает, что альтернативы у агента нет, и второй
// отказ даст цикл вместо результата.
export function respond(input, reason) {
  if (!reason) finish(null);

  // Без session_id предохранителю не на что опираться (так гарды зовёт тест-
  // харнес): считать разные прогоны одной сессией — значит терять запреты.
  const key = denialKey(input.tool_name, input.tool_input);
  if (input.session_id && breakerAllows(input.session_id, key)) {
    finish({
      systemMessage:
        `tokensave-гард: пропускаю повторный ${input.tool_name} — первый запрет не сработал ` +
        '(проверь sync и ветку графа: tokensave_status).',
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
