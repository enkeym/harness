// Подсказка `/model opus`: Sonnet трижды подряд провалил одну и ту же проверку
// (tsc, тест, линтер), и между попытками были правки. Сигнал — не объём задачи,
// а то, что модель при полном контексте пробовала и всё равно ошибается: тогда
// стоит модель сильнее. Крупное и так уходит в plan mode, то есть в Opus.
//
// Хук модель не меняет — такого вывода у хука нет. Пользователю — systemMessage
// с командой, модели — не пробовать вслепую четвёртый раз, а предложить
// переключение через меню. Раз за сессию: подсказка, повторённая на каждом
// провале, превратилась бы в шум.
//
// Провал Bash приходит событием PostToolUseFailure (`error: "Exit code N…"`),
// успех — PostToolUse. «Та же проверка» — команда с ужатыми пробелами: агент
// повторяет её дословно, а обёртку output-clip она получает одинаковую.
// Повтор без правки между попытками не считается: это не новая попытка починить.
//
// Модуль чистый — без stdin и вывода.

import { statePath, readJSON, writeJSON } from './state-core.mjs';
import { contextUsed } from './context-core.mjs';

const FAIL_LIMIT = 3;
const COMMAND_SHOWN = 120;

// Проверки, чей провал значит «код неверен», а не «команда не нашла».
const CHECK = new RegExp([
  String.raw`\b(tsc|jest|vitest|pytest|eslint|biome|ruff|mypy|pyflakes|playwright)\b`,
  String.raw`\b(npm|pnpm|yarn|bun)\s+(run\s+)?(test|lint|typecheck|type-check|check|build)\b`,
  String.raw`\b(cargo|go)\s+test\b`,
  String.raw`\btest[-_][\w.-]+\.(mjs|cjs|js|ts|py)\b`,
].join('|'));

const stateFile = (sid) => (/^[\w-]+$/.test(String(sid || '')) ? statePath(`model-hint-${sid}.json`) : null);

const keyOf = (command) => String(command || '').replace(/\s+/g, ' ').trim();

const onSonnet = (transcriptPath) => /sonnet/i.test(contextUsed(transcriptPath)?.model || '');

// Вход PostToolUse (правка или Bash) / PostToolUseFailure (Bash).
// → { message, context } | null.
export function noteCheck(input) {
  const file = stateFile(input.session_id);
  if (!file) return null;
  const state = readJSON(file, { edits: 0, checks: {} });
  if (state.hinted) return null;

  if (input.tool_name !== 'Bash') {
    state.edits = (state.edits || 0) + 1;
    writeJSON(file, state);
    return null;
  }

  const key = keyOf(input.tool_input?.command);
  if (!CHECK.test(key)) return null;
  state.checks ||= {};
  const prev = state.checks[key];
  if (input.hook_event_name !== 'PostToolUseFailure') {
    if (prev) {
      delete state.checks[key];
      writeJSON(file, state);
    }
    return null;
  }
  if (input.is_interrupt || (prev && prev.edits === state.edits)) return null;

  const fails = (prev?.fails || 0) + 1;
  state.checks[key] = { fails, edits: state.edits || 0 };
  const hint = fails >= FAIL_LIMIT && onSonnet(input.transcript_path);
  if (hint) state.hinted = true;
  writeJSON(file, state);
  if (!hint) return null;

  const shown = key.length > COMMAND_SHOWN ? `${key.slice(0, COMMAND_SHOWN)}…` : key;
  return {
    message: `Sonnet ${fails} раза подряд не прошёл \`${shown}\` с правками между попытками. `
      + 'Этот баг стоит отдать Opus: `/model opus`, после — вернуть прежнюю модель.',
    context: `model-hint: \`${shown}\` failed ${fails} times in a row on Sonnet with edits between attempts. `
      + 'Do not try a fourth blind fix. State in two lines what fails and what you already tried, then offer '
      + 'through AskUserQuestion: «Переключиться на Opus» first (the user runs `/model opus` and says «продолжи»), '
      + '«Ещё попытка на Sonnet» second. Shown once per session.',
  };
}
