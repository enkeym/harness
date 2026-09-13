// Общий ввод/вывод PreToolUse-хуков Claude Code: разбор stdin, формат ответа,
// предохранитель от повторных запретов, журнал решений и захват падений.
// Три роутера (edit, read/search, bash) отличаются только тем, какую функцию
// guard-core они зовут; ask-guard и security-guard берут отсюда ввод и журнал.

import { breakerAllows, denialKey, logGuard } from '../guard-core.mjs';
import { setHookContext, logDecision, logSlowIfNeeded, logCrash } from '../hooklog-core.mjs';
import { maybeSpawnDoctor } from '../doctor-core.mjs';
import { repoRootOr } from '../state-core.mjs';

// tokensave падает не на одном файле, а на всём графе (MCP на чужой ветке, лок
// БД, смена схемы). Раз повтор случился — гасим первый отказ и для соседних
// целей того же класса, иначе агент собирает по отказу на каждый файл.
const GUARD_FAMILY = {
  Read: 'read', Grep: 'read',
  Edit: 'edit', Write: 'edit',
  Bash: 'bash', mcp__ide__executeCode: 'bash',
};

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

// Единый выход для хуков без предохранителя (ask-guard, security-guard):
// decision null → разрешено, иначе 'deny' | 'ask' с причиной. Как и respond,
// завершает процесс — управление вызывающему не возвращается.
export function decide(input, decision, reason) {
  if (!decision) allow();
  logDecision(decision, { target: targetOf(input), reason });
  finish(verdictPayload(decision, reason));
}

function targetOf(input) {
  const key = denialKey(input.tool_name, input.tool_input);
  return key.slice(String(input.tool_name || '').length + 1);
}

// reason === null → вызов разрешён. Иначе запрет, но только первый на эту цель
// (и на соседние того же класса, если повтор уже случился): альтернативы у
// агента нет, и второй отказ даёт цикл вместо результата.
export function respond(input, reason) {
  if (!reason) allow();

  const family = GUARD_FAMILY[input.tool_name] || null;
  const target = targetOf(input);

  // Shell/eval — не санкционированная замена tokensave ни при каких условиях:
  // для чтения и правки индексированного файла всегда есть Read/Edit и
  // tokensave_*. Предохранитель (спасает Read/Edit от зацикливания) на bash не
  // распространяется — повторный cat/sed/node -e по файлу из индекса остаётся
  // под запретом. Реально лёгший tokensave отсекается раньше, в guard-core:
  // serverState видит, что живого сервера на этот проект/ветку нет, и query
  // возвращает null (fail-open) — сюда управление уже не доходит.
  if (family === 'bash') {
    logDecision('deny', { target, reason });
    finish(verdictPayload('deny', reason));
  }

  // Без session_id предохранителю не на что опираться (так гарды зовёт тест-
  // харнес): считать разные прогоны одной сессией — значит терять запреты.
  const key = denialKey(input.tool_name, input.tool_input);
  const verdict = input.session_id && breakerAllows(input.session_id, key, family);

  if (verdict) {
    const detail = {
      tool: input.tool_name,
      target,
      cwd: input.cwd || null,
      family,
      announced: verdict === 'announce',
    };
    // Дедуп тот же, что у guard.log: пока латч открыт, пропускается каждое
    // чтение, и строка на каждое — шум.
    if (logGuard('breaker-open', detail)) {
      logDecision('breaker-open', { target, family, announced: detail.announced });
    }
  }

  // Объясняем один раз за окно; дальше пропускаем молча — повторение того же
  // текста к каждому чтению было шумом, а не информацией.
  if (verdict === 'announce') {
    // Первый открытый предохранитель в классе и есть момент «модель
    // спотыкается»: запускаем фонового доктора (дебаунс и бюджет — внутри).
    maybeSpawnDoctor({
      root: repoRootOr(input.cwd),
      symptom: 'breaker-open',
      detail: { tool: input.tool_name, target, family },
      sid: input.session_id,
    });
    finish({
      systemMessage:
        `tokensave-гард: ${input.tool_name} пропущен — повтор вызова, защита от цикла. Индекс цел. ` +
        'Дальше: tokensave_status → вернись на tokensave_* (нет в списке → ToolSearch). ' +
        `${input.tool_name} — только при ошибке tokensave. Shell — никогда. Лог: ~/.ai-hooks/logs/guard.log.`,
    });
  }
  if (verdict === 'silent') finish(null);

  logDecision('deny', { target, reason });
  finish(verdictPayload('deny', reason));
}
