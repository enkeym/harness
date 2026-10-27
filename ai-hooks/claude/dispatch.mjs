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
//   context          → через пустую строку в порядке таблицы; message — построчно;
//   block            → ответ, остальные проверки события не идут.
// Падение проверки → crash в журнал под её именем, остальные работают.
//
// PreToolUse без deny и ask → allow: защита — гарды, штатный вопрос Claude Code
// о разрешении не задаётся ни в одном режиме. Кроме окон, где человек выбирает
// сам (вопрос, план, перенос handoff), и plan mode — там правки закрыты режимом.
// deny из permissions и от хука tokensave сильнее allow.
//
// Проект со своим ядром гардов (ai-kit: `.claude/settings.json` зовёт
// `ai/hooks/run.mjs`) сам выдаёт карту связей — links-context здесь молчит.
// Вердикт security-guard сверяется с `policy()` проекта — тем же, что зовёт
// его run.mjs: проект запретил — харнес молчит, проект спросил — харнес снимает
// свой ask, проект молчит — вердикт харнеса остаётся (`gh auth token`, push).
// Иначе один отказ и один вопрос приходили бы дважды. Ядро проекта не
// загрузилось — вердикт харнеса целиком. Файла без подключённого хука мало:
// иначе проект до `link` оставался бы без гарда секретов вовсе.

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { setHookContext, logSlowIfNeeded, logCrash } from '../hooklog-core.mjs';
import { readInput, finish, logVerdict, payloadOf } from './hook-io.mjs';

const ALL = null;
const EDIT_MCP = 'mcp__tokensave__tokensave_';
const PROJECT_GUARDS = 'ai/hooks/run.mjs';
const PROJECT_POLICY = 'ai/hooks/policy.mjs';
const CHOICE_TOOLS = /^(AskUserQuestion|ExitPlanMode|EnterPlanMode)$/;
const EDIT_TOOLS = new RegExp(`^(Edit|Write|MultiEdit|${EDIT_MCP}(str_replace|multi_str_replace|replace_lines|insert_at|insert_at_symbol|replace_symbol))$`);

const PROJECT_SKIP = new Set(['links-context']);
// project: { level, reason } | null — вердикт проекта; undefined — не узнать.
const PROJECT_FILTER = {
  'security-guard': (result, project) => {
    if (project === undefined) return result;
    if (project?.level === 'deny') return null;
    return project?.level === 'ask' && result.decision === 'ask' ? null : result;
  },
};

const projectRoot = (input) => process.env.CLAUDE_PROJECT_DIR || input.cwd;

function projectOwnsGuards(input) {
  const root = projectRoot(input);
  if (!root || !fs.existsSync(path.join(root, PROJECT_GUARDS))) return false;
  try {
    return fs.readFileSync(path.join(root, '.claude', 'settings.json'), 'utf8').includes(PROJECT_GUARDS);
  } catch {
    return false;
  }
}

async function projectVerdict(input) {
  const root = projectRoot(input);
  try {
    const { policy } = await import(pathToFileURL(path.join(root, PROJECT_POLICY)).href);
    return policy(input.tool_name, input.tool_input, { root, cwd: input.cwd || root }) ?? null;
  } catch (e) {
    logCrash(e);
    return undefined;
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
    ['handoff-mark', /^ExitPlanMode$/],
    ['links-context', EDIT_TOOLS],
    ['model-hint', new RegExp(`${EDIT_TOOLS.source}|^Bash$`)],
  ],
  // Провал инструмента; ненулевой выход Bash — тоже он.
  PostToolUseFailure: [
    ['model-hint', /^Bash$/],
  ],
  UserPromptSubmit: [
    // Первым: стёртый промпт не помечает скилл и не несёт контекст.
    ['paste-guard', ALL],
    ['handoff-drop', ALL],
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
  const joined = (key, sep) => results.map((r) => r[key]).filter(Boolean).join(sep);
  const context = joined('context', '\n\n');
  const message = joined('message', '\n');
  return context || message ? { context, message } : null;
}

function permit(event, input, result) {
  if (event !== 'PreToolUse' || result?.decision) return result;
  if (input.permission_mode === 'plan' || CHOICE_TOOLS.test(String(input.tool_name || ''))) return result;
  return { ...result, decision: 'allow' };
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
      let result = check(input);
      const filter = projectGuards && PROJECT_FILTER[name];
      if (filter && result?.decision) result = filter(result, await projectVerdict(input));
      if (!result) continue;
      logVerdict(input, result);
      if (result.block) return result;
      results.push(result);
    } catch (e) {
      logCrash(e);
    }
  }
  return permit(event, input, merge(results));
}

readInput(async (input) => {
  const event = process.argv[2] || input.hook_event_name;
  const result = await dispatch(event, input);
  // Медленный проход — одна строка на весь процесс: ms считается от его старта.
  setHookContext(input, 'dispatch');
  logSlowIfNeeded();
  finish(payloadOf(event, result));
});
