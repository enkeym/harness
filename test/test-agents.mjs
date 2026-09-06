#!/usr/bin/env node
// Проверка определений ролей и скиллов Claude Code без их запуска.
//
// Живой прогон агента стоит токенов и ловит поведение; здесь ловится то, что
// ломается молча и не видно до первого вызова: опечатка в имени инструмента
// (Claude тихо отдаст агенту пустой список), несуществующий скилл в skills:,
// невалидная модель, разъехавшиеся имя файла и поле name, коллизия имён между
// ролью и скиллом. Всё это ошибки конфигурации, а не поведения, и проверять их
// надо статически.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const HOME = process.env.HOME || os.homedir();
const AGENTS_DIR = path.join(HOME, '.claude', 'agents');
const SKILLS_DIR = path.join(HOME, '.claude', 'skills');

const VALID_MODELS = new Set(['sonnet', 'opus', 'haiku', 'fable', 'inherit']);
const VALID_EFFORT = new Set(['low', 'medium', 'high', 'xhigh', 'max']);
const VALID_COLORS = new Set(['red', 'blue', 'green', 'yellow', 'purple', 'orange', 'pink', 'cyan']);

// Встроенные инструменты Claude Code. Список неполный по замыслу: незнакомое
// имя без префикса mcp__ — почти всегда опечатка, а не новый инструмент.
const BUILTIN_TOOLS = new Set([
  'Read', 'Write', 'Edit', 'NotebookEdit', 'Bash', 'Glob', 'Grep', 'Agent',
  'Skill', 'ToolSearch', 'WebFetch', 'WebSearch', 'Artifact', 'AskUserQuestion',
  'TaskOutput', 'TaskStop', 'Monitor', 'SendMessage', 'ListAgents',
  'EnterPlanMode', 'ExitPlanMode', 'ReportFindings', 'SendFeedback',
]);

let failed = 0;
const fail = (where, msg) => { process.stdout.write(`FAIL ${where}: ${msg}\n`); failed++; };
const ok = (where, msg) => process.stdout.write(`ok   ${where}: ${msg}\n`);

// Разбор frontmatter достаточен для наших полей: скаляры и списки в двух
// формах (инлайн через запятую и блочный через дефисы). YAML целиком не нужен.
function frontmatter(text) {
  const m = text.match(/^---\n([\s\S]*?)\n---/);
  if (!m) return null;
  const out = {};
  let key = null;
  for (const line of m[1].split('\n')) {
    const kv = line.match(/^([\w-]+):\s*(.*)$/);
    if (kv) {
      key = kv[1];
      out[key] = kv[2].trim();
      if (out[key] === '') out[key] = [];
      continue;
    }
    const item = line.match(/^\s*-\s+(.*)$/);
    if (item && key && Array.isArray(out[key])) out[key].push(item[1].trim());
  }
  return out;
}

function toolNames(spec) {
  if (!spec || Array.isArray(spec)) return [];
  // «Bash(git status:*)» — ограниченная форма; имя инструмента до скобки.
  return String(spec).split(',').map((t) => t.trim().split('(')[0].trim()).filter(Boolean);
}

function checkTools(where, spec, field) {
  for (const name of toolNames(spec)) {
    if (name.startsWith('mcp__') || BUILTIN_TOOLS.has(name)) continue;
    fail(where, `${field}: неизвестный инструмент «${name}» — Claude отдаст агенту пустой список`);
  }
}

// --- роли
const agentNames = new Set();
for (const file of fs.existsSync(AGENTS_DIR) ? fs.readdirSync(AGENTS_DIR).filter((f) => f.endsWith('.md')) : []) {
  const where = `агент ${file}`;
  const fm = frontmatter(fs.readFileSync(path.join(AGENTS_DIR, file), 'utf8'));
  if (!fm) { fail(where, 'нет frontmatter'); continue; }

  const expected = path.basename(file, '.md');
  if (fm.name !== expected) fail(where, `name «${fm.name}» не совпадает с именем файла «${expected}»`);
  if (!fm.description || String(fm.description).length < 40) {
    fail(where, 'description короче 40 символов — Claude не сможет выбрать роль по нему');
  }
  if (fm.model && !VALID_MODELS.has(fm.model) && !/^claude-/.test(fm.model)) {
    fail(where, `model «${fm.model}» невалидна`);
  }
  if (fm.effort && !VALID_EFFORT.has(fm.effort)) fail(where, `effort «${fm.effort}» невалиден`);
  if (fm.color && !VALID_COLORS.has(fm.color)) fail(where, `color «${fm.color}» невалиден`);
  if (fm.maxTurns && !/^\d+$/.test(fm.maxTurns)) fail(where, `maxTurns «${fm.maxTurns}» не число`);

  checkTools(where, fm.tools, 'tools');
  checkTools(where, fm.disallowedTools, 'disallowedTools');
  if (fm.tools && fm.disallowedTools) fail(where, 'заданы и tools, и disallowedTools — второе игнорируется');

  agentNames.add(fm.name);
  if (!failed) ok(where, `${fm.model || 'модель по умолчанию'}`);
}

// --- скиллы
const skillNames = new Set();
const skillDirs = fs.existsSync(SKILLS_DIR)
  ? fs.readdirSync(SKILLS_DIR).filter((d) => fs.existsSync(path.join(SKILLS_DIR, d, 'SKILL.md'))) : [];
for (const dir of skillDirs) {
  const where = `скилл ${dir}`;
  const fm = frontmatter(fs.readFileSync(path.join(SKILLS_DIR, dir, 'SKILL.md'), 'utf8'));
  if (!fm) { fail(where, 'нет frontmatter'); continue; }
  if (fm.name !== dir) fail(where, `name «${fm.name}» не совпадает с каталогом «${dir}»`);
  if (!fm.description) fail(where, 'нет description');
  checkTools(where, fm['allowed-tools'], 'allowed-tools');
  skillNames.add(fm.name);
}

// --- перекрёстные проверки
for (const file of fs.existsSync(AGENTS_DIR) ? fs.readdirSync(AGENTS_DIR).filter((f) => f.endsWith('.md')) : []) {
  const fm = frontmatter(fs.readFileSync(path.join(AGENTS_DIR, file), 'utf8'));
  for (const s of Array.isArray(fm?.skills) ? fm.skills : []) {
    if (!skillNames.has(s)) fail(`агент ${file}`, `skills: скилл «${s}» не существует`);
  }
}
for (const name of agentNames) {
  if (skillNames.has(name)) fail('имена', `«${name}» — и роль, и скилл: вызов по имени станет двусмысленным`);
}

process.stdout.write(`\nролей: ${agentNames.size}, скиллов: ${skillNames.size}\n`);
process.stdout.write(failed ? `=== ${failed} FAIL ===\n` : '=== все проверки прошли ===\n');
process.exit(failed ? 1 : 0);
