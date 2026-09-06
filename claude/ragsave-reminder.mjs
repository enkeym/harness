#!/usr/bin/env node
// Claude Code, UserPromptSubmit: напоминание про rag_search на смысловых запросах.
//
// Зачем нужен. У tokensave три PreToolUse-гарда плюс собственный hook-prompt-submit,
// то есть про него агенту напоминают в каждом промпте. У ragsave гардов нет и быть
// не должно: он ничего не запрещает. Асимметрия приводила к тому, что агент уходил
// в tokensave_search по угаданному имени (или в Grep) там, где вопрос был смысловым,
// а ответ лежал в доке или конфиге — вне графа tokensave.
//
// Это не гард: вывод не запрещает вызовы, а добавляет контекст к промпту.
// Молчит везде, где напоминание бессмысленно или вредно:
//   нет .ragsave/rag.db          → нечего искать;
//   в промпте названы файл/символ → это tokensave, подсказка сбивала бы;
//   вопрос структурный           → callers/impact дают точный ответ, RAG — похожий;
//   слэш-команда                 → не запрос к коду;
//   напоминали недавно           → дроссель, иначе шум вместо сигнала.
// Любая ошибка → выход без вывода: пропущенная подсказка дешевле сломанного промпта.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const HOME = process.env.HOME || os.homedir();
const DB_REL = path.join('.ragsave', 'rag.db');
const THROTTLE_MS = 15 * 60 * 1000;
const STATE_DIR = path.join(HOME, '.claude', 'state', 'ragsave-reminder');

// Границы слова через \b не годятся: \w — это [A-Za-z0-9_], поэтому для кириллицы
// \bкак\b не срабатывает. Берём lookaround по букве любого алфавита.
function wordsRe(words) {
  return new RegExp(`(?<!\\p{L})(?:${words.join('|')})(?!\\p{L})`, 'iu');
}

// Вопрос сформулирован словами, а не именем.
const SEMANTIC_RE = wordsRe([
  'как', 'где', 'почему', 'зачем', 'отку[дд]а', 'куда', 'что за', 'каким образом',
  'разберись', 'объясни', 'выясни', 'посмотри как', 'подскажи где',
  'how', 'where', 'why', 'explain', 'figure out', 'find where', 'what kind of',
]);

// Структурные вопросы — прицельная работа tokensave, RAG тут только размывает ответ.
const STRUCTURAL_RE = wordsRe([
  'кто вызывает', 'кто использует', 'что сломается', 'что затронет', 'зависимости',
  'callers', 'callees', 'impact', 'who calls', 'what breaks',
]);

// Явный указатель на имя: путь с расширением, идентификатор в бэктиках,
// camelCase/PascalCase, snake_case, вызов вида foo().
const NAMED_RE = new RegExp(
  [
    '`[^`]+`',
    '[\\w./-]+\\.(?:ts|tsx|js|jsx|mjs|cjs|py|rs|go|java|kt|rb|php|cs|cpp|c|h|sql|prisma|vue|svelte|json|ya?ml|toml|env|md)(?![\\w])',
    '[A-Za-z][a-z0-9]*[A-Z][A-Za-z0-9]*',
    '[A-Za-z][A-Za-z0-9]*_[A-Za-z0-9]+',
    '[A-Za-z_$][\\w$]*\\s*\\(\\s*\\)',
  ].join('|'),
);

const REMINDER = [
  'В этом проекте есть смысловой индекс ragsave (.ragsave/rag.db), и текущий запрос',
  'сформулирован смыслом, а не именем символа. Первым поисковым вызовом делай',
  'mcp__ragsave__rag_search — не tokensave_search по угаданному имени и не Grep.',
  'ragsave покрывает то, чего в графе tokensave нет: доки, json/yaml, .env, миграции, CI.',
  'Назвал символ или файл — возвращайся к tokensave; структурные вопросы (кто вызывает,',
  'что сломается) — всегда tokensave_callers / tokensave_impact.',
].join(' ');

// Ближайший каталог вверх по дереву с индексом ragsave. $HOME не считается
// проектом — по той же причине, что и в guard-core.
function findRagRoot(startDir) {
  let dir = path.resolve(startDir);
  for (;;) {
    if (fs.existsSync(path.join(dir, DB_REL))) {
      return path.resolve(dir) === path.resolve(HOME) ? null : dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

// Один и тот же проект в одной сессии напоминаем не чаще THROTTLE_MS.
// Метка не критична: не смогли записать — напомним ещё раз, это безобидно.
function throttled(sessionId, root) {
  const key = `${sessionId}-${Buffer.from(root).toString('base64url')}`.slice(0, 120);
  const stamp = path.join(STATE_DIR, key);
  try {
    const age = Date.now() - fs.statSync(stamp).mtimeMs;
    if (age < THROTTLE_MS) return true;
  } catch {
    // метки нет — первое напоминание в этой сессии
  }
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.writeFileSync(stamp, '');
  } catch {
    // не смогли записать — не повод молчать
  }
  return false;
}

function emit(context) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'UserPromptSubmit',
      additionalContext: context,
    },
  }));
}

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => { raw += c; });
process.stdin.on('end', () => {
  let input;
  try { input = JSON.parse(raw); } catch { process.exit(0); }

  const prompt = String(input.prompt || '');
  if (!prompt.trim() || prompt.trimStart().startsWith('/')) process.exit(0);
  if (!SEMANTIC_RE.test(prompt)) process.exit(0);
  if (STRUCTURAL_RE.test(prompt)) process.exit(0);
  if (NAMED_RE.test(prompt)) process.exit(0);

  const cwd = input.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd();
  let root;
  try { root = findRagRoot(cwd); } catch { process.exit(0); }
  if (!root) process.exit(0);

  if (throttled(String(input.session_id || 'default'), root)) process.exit(0);

  emit(REMINDER);
  process.exit(0);
});
