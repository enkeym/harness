#!/usr/bin/env node
// Claude Code: один процесс node на событие вместо процесса на хук.
// `dispatch.mjs <Event>` зовёт check(input) адаптеров из TABLE и отдаёт один
// ответ. Старт node ~100 мс, а Bash раньше поднимал шесть таких процессов;
// ожидание хода почти то же (параллельные хуки ждали самого медленного),
// экономия — процессы и CPU, регистрация — в одном месте.
//
// Адаптеры остаются точками входа (тесты зовут их по пути). Matcher здесь —
// те же регэкспы, что были в claude/settings.json; модуль грузится только
// для подошедшего инструмента.
//
// Слияние — как при параллельных хуках: каждая проверка судит исходный вход.
//   deny у кого-то   → deny, причины всех запретивших через \n, правки входа отброшены;
//   ask              → ask (+ updatedInput, если был);
//   updatedInput     → он; matcher tool-args и output-clip не пересекаются;
//   context          → через пустую строку в порядке таблицы;
//   block            → ответ, остальные проверки события не идут.
// Падение проверки → crash в журнал под её именем, остальные работают.
//
// Проект со своим ядром гардов (ai-kit: `.claude/settings.json` зовёт
// `ai/hooks/run.mjs`) сам запрещает чтение секретов и выдаёт карту связей: здесь links-context молчит, у security-guard
// отбрасывается deny (секреты), ask остаётся. Иначе один отказ и один блок
// карты приходили бы дважды. Файла без подключённого хука мало: иначе проект
// до `link` оставался бы без гарда секретов вовсе.

import fs from 'node:fs';
import path from 'node:path';
import { setHookContext, logSlowIfNeeded, logCrash } from '../hooklog-core.mjs';
import { readInput, finish, logVerdict, payloadOf } from './hook-io.mjs';

const ALL = null;
const EDIT_MCP = 'mcp__tokensave__tokensave_';
const PROJECT_GUARDS = 'ai/hooks/run.mjs';

const PROJECT_SKIP = new Set(['links-context']);
const PROJECT_FILTER = {
  'security-guard': (result) => (result?.decision === 'deny' ? null : result),
};

function projectOwnsGuards(input) {
  const root = process.env.CLAUDE_PROJECT_DIR || input.cwd;
  if (!root || !fs.existsSync(path.join(root, PROJECT_GUARDS))) return false;
  try {
    return fs.readFileSync(path.join(root, '.claude', 'settings.json'), 'utf8').includes(PROJECT_GUARDS);
  } catch {
    return false;
  }
}

// [имя, matcher | ALL, модуль]. Имя уходит в hooks.jsonl — то же, что у
// отдельного хука; модуль по умолчанию — ./<имя>.mjs. У UserPromptSubmit и Stop
// инструмента нет — там только ALL.
const TABLE = {
  PreToolUse: [
    ['ask-guard', ALL],
    ['security-guard', ALL],
    ['skill-track', /^Skill$/],
    ['skill-gate', new RegExp(`^(Edit|Write|MultiEdit|NotebookEdit|Bash|${EDIT_MCP}(str_replace|multi_str_replace|replace_lines|insert_at))$`)],
    ['bash-router', /^(Bash|mcp__ide__executeCode)$/],
    ['read-router', /^Read$/],
    ['tool-args', new RegExp(`^${EDIT_MCP}(read|str_replace|multi_str_replace)$`)],
    ['plan-guard', /^ExitPlanMode$/],
    // Последним из правящих вход: гарды судят исходную команду.
    ['output-clip', /^Bash$/],
    ['scratch', /^(Bash|Write)$/],
  ],
  PostToolUse: [
    ['context-step', ALL],
    ['links-context', new RegExp(`^(Edit|Write|MultiEdit|${EDIT_MCP}(str_replace|multi_str_replace|replace_lines|insert_at|insert_at_symbol|replace_symbol))$`)],
  ],
  UserPromptSubmit: [
    // Первым: стёртый промпт не помечает скилл и не несёт контекст.
    ['paste-guard', ALL],
    ['skill-track', ALL],
    ['ask-reminder', ALL],
    ['context-meter', ALL],
  ],
  Stop: [
    ['usage-log', ALL],
    ['cleanup', ALL, '../bin/cleanup.mjs'],
    // Блок — ход не кончен: черновики уберёт повторный Stop.
    ['question-guard', ALL],
    ['scratch', ALL],
  ],
};

function merge(results) {
  const denies = results.filter((r) => r.decision === 'deny');
  if (denies.length) return { decision: 'deny', reason: denies.map((r) => r.reason).join('\n') };
  const updatedInput = results.find((r) => r.updatedInput)?.updatedInput;
  const asks = results.filter((r) => r.decision === 'ask');
  if (asks.length) return { decision: 'ask', reason: asks.map((r) => r.reason).join('\n'), updatedInput };
  if (updatedInput) return { updatedInput };
  const context = results.map((r) => r.context).filter(Boolean).join('\n\n');
  return context ? { context } : null;
}

async function dispatch(event, input) {
  const results = [];
  const projectGuards = projectOwnsGuards(input);
  for (const [name, matcher, file = `./${name}.mjs`] of TABLE[event] || []) {
    if (matcher && !matcher.test(String(input.tool_name || ''))) continue;
    if (projectGuards && PROJECT_SKIP.has(name)) continue;
    setHookContext(input, name);
    try {
      const { check } = await import(new URL(file, import.meta.url));
      const filter = projectGuards && PROJECT_FILTER[name];
      const result = filter ? filter(check(input)) : check(input);
      if (!result) continue;
      logVerdict(input, result);
      if (result.block) return result;
      results.push(result);
    } catch (e) {
      logCrash(e);
    }
  }
  return merge(results);
}

readInput(async (input) => {
  const event = process.argv[2] || input.hook_event_name;
  const result = await dispatch(event, input);
  // Медленный проход — одна строка на весь процесс: ms считается от его старта.
  setHookContext(input, 'dispatch');
  logSlowIfNeeded();
  finish(payloadOf(event, result));
});
