// Общий ввод/вывод хуков Claude Code: разбор stdin, формат ответа, журнал
// решений и захват падений. Адаптер экспортирует check(input) и отдаёт его
// runHook, когда запущен сам; claude/dispatch.mjs зовёт те же check в одном
// процессе на событие.
//
// Ответ check: null — молчит; { decision: 'deny'|'ask', reason } — решение о
// вызове; { updatedInput, reason } — исправленный вход; { context } —
// additionalContext; { block: reason } — промпт стёрт или ход не завершён.

import { setHookContext, logDecision, logSlowIfNeeded, logCrash } from '../hooklog-core.mjs';

// Ошибка разбора stdin → пропускаем вызов: хук не должен ломать работу агента.
// Исключение внутри хука раньше роняло процесс с ненулевым кодом: Claude
// показывал «hook error», шёл дальше, а причина не оставалась нигде. Теперь
// падение уходит в журналы, а вызов пропускается — fail-open, как и у гардов.
// Перехват ставится здесь, а не при импорте: тест, взявший из адаптера
// функцию, иначе выходил бы с кодом 0 на любом своём исключении.
export function readInput(cb) {
  process.on('uncaughtException', (e) => { logCrash(e); process.exit(0); });
  process.on('unhandledRejection', (e) => { logCrash(e); process.exit(0); });
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

export function finish(payload) {
  if (payload) process.stdout.write(JSON.stringify(payload));
  process.exit(0);
}

// Цель вызова для журнала: путь, команда, код или паттерн — что есть.
function targetOf(input) {
  const ti = input.tool_input || {};
  const target = ti.file_path || ti.path || ti.command || ti.code || ti.pattern || ti.glob
    || ti.planFilePath || '';
  return String(target).replace(/\s+/g, ' ').slice(0, 200);
}

// Строка журнала по ответу check; имя хука в контексте выставлено до вызова.
// Исправленный вход пишется только с причиной: обёртка шумной команды
// (output-clip) — штатный ход, а не решение.
export function logVerdict(input, result) {
  if (!result) return false;
  if (result.decision) return logDecision(result.decision, { target: targetOf(input), reason: result.reason });
  if (result.updatedInput && result.reason) return logDecision('rewrite', { target: targetOf(input), reason: result.reason });
  if (result.block) return logDecision('block', { reason: result.block });
  return false;
}

// Ответ check → JSON события. allow ставит только dispatch (permit): отдельный
// хук, что правит вход, о разрешении не решает.
export function payloadOf(event, result) {
  if (!result) return null;
  if (result.block) return { decision: 'block', reason: result.block };
  const out = { hookEventName: event };
  if (result.context) out.additionalContext = result.context;
  if (result.decision) {
    out.permissionDecision = result.decision;
    out.permissionDecisionReason = result.reason;
  }
  if (result.updatedInput) out.updatedInput = result.updatedInput;
  return { hookSpecificOutput: out };
}

// Точка входа одной проверки. Падение check → crash в журнал и молчание.
// Медленный проход пишется, только если решения в журнале нет.
export function runHook(check, event) {
  readInput((input) => {
    let result = null;
    try { result = check(input); } catch (e) { logCrash(e); }
    if (!logVerdict(input, result)) logSlowIfNeeded();
    finish(payloadOf(event, result));
  });
}
