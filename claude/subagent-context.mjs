#!/usr/bin/env node
// Claude Code, SubagentStart: правило tokensave/ragsave — в контекст субагента.
//
// Субагент (имплементер или ревьюер Superpowers, Explore, Plan) стартует с
// пустым контекстом: CLAUDE.md, напоминания UserPromptSubmit и hook-prompt-submit
// tokensave до него не доходят. Гарды PreToolUse на него действуют, поэтому без
// этого контекста первый же Read по проиндексированному файлу — отказ, который
// субагент видит впервые и начинает обходить. Здесь он узнаёт правило до
// первого вызова. Молчит вне tokensave/ragsave-проекта — там и гарды молчат.

import fs from 'node:fs';
import path from 'node:path';
import { projectRoot } from '../guard-core.mjs';
import { readInput } from './hook-io.mjs';

const TOKENSAVE_RULES = [
  'Проект проиндексирован tokensave. Файлы из индекса читай и правь ТОЛЬКО через MCP tokensave, ' +
    'Read/Grep/Edit/Write и shell (cat, sed -i, node -e, > file) на них заблокированы хуком.',
  'Чтение: mcp__tokensave__tokensave_read (файл), tokensave_body / tokensave_signature (символ), ' +
    'tokensave_context (понимание вокруг известной точки, скоупь path_include). ' +
    'Поиск: tokensave_search (символ; literal:true для строки), tokensave_callers / tokensave_impact (использования). ' +
    'Правка: tokensave_str_replace / tokensave_multi_str_replace (точечно), tokensave_replace_symbol (символ целиком), ' +
    'tokensave_insert_at / tokensave_insert_at_symbol (вставка). Новый файл — обычный Write.',
  'Полное имя — mcp__tokensave__tokensave_<tool>; нет его в списке инструментов — ' +
    "сначала ToolSearch(\"select:mcp__tokensave__tokensave_read\").",
  'Bash — только для команд: git, npm, tsc, тесты, линтеры. Не для чтения и записи файлов.',
  'Отказ гарда — не препятствие, а указание на нужный инструмент. Если tokensave ответил ошибкой или ' +
    'пустотой — скажи об этом и работай обычными инструментами; повторять тот же вызов не нужно.',
  'Своих субагентов не запускай: ревью и декомпозиция — работа контроллера.',
];

const RAGSAVE_RULE =
  'Вопрос по смыслу без имени файла или символа (как / где / почему; конфиги, доки, миграции, CI) — ' +
  'сначала mcp__ragsave__rag_search, а не догадка имени в tokensave_search и не Grep.';

function gitRoot(cwd) {
  let dir = path.resolve(cwd || process.cwd());
  while (dir) {
    if (fs.existsSync(path.join(dir, '.git'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}

function hasRagsave(cwd) {
  const root = gitRoot(cwd);
  return Boolean(root && fs.existsSync(path.join(root, '.ragsave', 'rag.db')));
}

export function subagentContext(cwd) {
  const lines = [];
  if (projectRoot(cwd)) lines.push(...TOKENSAVE_RULES);
  if (hasRagsave(cwd)) lines.push(RAGSAVE_RULE);
  if (lines.length === 0) return null;
  return `Правила инструментов в этом проекте (действуют и на тебя как субагента):\n- ${lines.join('\n- ')}`;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  readInput((input) => {
    const context = subagentContext(input.cwd);
    if (context) {
      process.stdout.write(JSON.stringify({
        hookSpecificOutput: { hookEventName: 'SubagentStart', additionalContext: context },
      }));
    }
    process.exit(0);
  });
}
