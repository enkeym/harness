// Общий ввод/вывод PreToolUse-хуков Claude Code: разбор stdin, формат ответа,
// журнал решений и захват падений. bash-router, ask-guard и security-guard
// берут отсюда ввод и выход.

import { setHookContext, logDecision, logSlowIfNeeded, logCrash } from '../hooklog-core.mjs';

// Исключение внутри хука раньше роняло процесс с ненулевым кодом: Claude
// показывал «hook error», шёл дальше, а причина не оставалась нигде. Теперь
// падение уходит в журналы, а вызов пропускается — fail-open, как и у гардов.
process.on('uncaughtException', (e) => { logCrash(e); process.exit(0); });
process.on('unhandledRejection', (e) => { logCrash(e); process.exit(0); });

// Ошибка разбора stdin → пропускаем вызов: хук не должен ломать работу агента.
export function readInput(cb) {
  let raw = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (c) => { raw += c; });
  process.stdin.on('end', () => {
    let input;
    try { input = JSON.parse(raw); } catch { process.exit(0); }
    setHookContext(input);
    cb(input);
  });
}

function finish(payload) {
  if (payload) process.stdout.write(JSON.stringify(payload));
  process.exit(0);
}

// Разрешённый вызов: в журнал попадает только медленный проход.
function allow() {
  logSlowIfNeeded();
  finish(null);
}

function verdictPayload(decision, reason) {
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: decision,
      permissionDecisionReason: reason,
    },
  };
}

// Цель вызова для журнала: путь, команда, код или паттерн — что есть.
function targetOf(input) {
  const ti = input.tool_input || {};
  const target = ti.file_path || ti.path || ti.command || ti.code || ti.pattern || ti.glob || '';
  return String(target).replace(/\s+/g, ' ').slice(0, 200);
}

// Единый выход: decision null → разрешено, иначе 'deny' | 'ask' с причиной.
// Завершает процесс — управление вызывающему не возвращается.
export function decide(input, decision, reason) {
  if (!decision) allow();
  logDecision(decision, { target: targetOf(input), reason });
  finish(verdictPayload(decision, reason));
}

// reason === null → вызов разрешён, иначе запрет.
export function respond(input, reason) {
  decide(input, reason ? 'deny' : null, reason);
}
