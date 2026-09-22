#!/usr/bin/env node
// Статический контракт скиллов харнеса: frontmatter по skill-authoring
// (name = каталог, описание в кавычках и ≤1024, командные скиллы с
// argument-hint), тело ≤130 строк, живые относительные ссылки, таблица
// core.md и строка user-invoked в CLAUDE.md сходятся с реальными скиллами,
// OpenCode закрывает командные скиллы, test-browser не зовётся ниоткуда,
// кроме пользователя, и в скиллах нет фактов конкретного проекта.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ~/.ai-hooks — симлинк в харнес: корень ищем от настоящего пути файла.
const HARNESS = path.resolve(path.dirname(fs.realpathSync(fileURLToPath(import.meta.url))), '..', '..');
const SKILLS = path.join(HARNESS, 'skills');
const read = (p) => fs.readFileSync(p, 'utf8');

let failed = 0;
function check(name, ok, detail = '') {
  process.stdout.write(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok || !detail ? '' : ` — ${detail}`}\n`);
  if (!ok) failed++;
}

// Первый блок --- … --- : ключ → сырое значение (кавычки сохраняются).
export function frontmatter(text) {
  const m = text.match(/^---\n([\s\S]*?)\n---\n/);
  if (!m) return null;
  const fields = {};
  for (const line of m[1].split('\n')) {
    const kv = line.match(/^([a-z-]+):\s?(.*)$/);
    if (kv) fields[kv[1]] = kv[2];
  }
  return { fields, body: text.slice(m[0].length) };
}

const unquote = (v) => (/^".*"$/.test(v) ? JSON.parse(v) : v);

// Каталоги скиллов: shared/ — общие правила без SKILL.md, synced/ и скрытые
// (.trash/) — чужие скиллы claude.ai, которые синхронизирует клиент.
const skillDirs = fs
  .readdirSync(SKILLS, { withFileTypes: true })
  .filter((d) => d.isDirectory() && !['shared', 'synced'].includes(d.name) && !d.name.startsWith('.'))
  .map((d) => d.name)
  .sort();

const skills = new Map();
for (const dir of skillDirs) {
  const file = path.join(SKILLS, dir, 'SKILL.md');
  check(`${dir}: есть SKILL.md`, fs.existsSync(file));
  if (!fs.existsSync(file)) continue;
  const fm = frontmatter(read(file));
  check(`${dir}: frontmatter читается`, !!fm);
  if (!fm) continue;
  skills.set(dir, { file, ...fm, command: fm.fields['disable-model-invocation'] === 'true' });
}

// --- frontmatter и тело ---
for (const [dir, s] of skills) {
  const { fields, body } = s;
  check(`${dir}: name = каталог`, fields.name === dir, `name=${fields.name}`);
  check(`${dir}: name в форме коллекции`, /^[a-z0-9-]{1,64}$/.test(dir) && !/claude|anthropic/.test(dir));

  const raw = fields.description || '';
  check(`${dir}: description в двойных кавычках`, /^".*"$/.test(raw));
  let desc = '';
  try {
    desc = unquote(raw);
  } catch {
    check(`${dir}: description — валидная строка в кавычках`, false, raw.slice(0, 60));
  }
  check(`${dir}: description ≤1024`, desc.length > 0 && desc.length <= 1024, `len=${desc.length}`);
  check(`${dir}: description без XML`, !/<\/?[a-z][^>]*>/i.test(desc));

  for (const [key, value] of Object.entries(fields)) {
    if (value.includes(': ') || value.startsWith('[')) {
      check(`${dir}: ${key} в кавычках (строгий YAML OpenCode)`, /^".*"$/.test(value), value.slice(0, 60));
    }
  }

  if (s.command) {
    check(`${dir}: командный скилл с argument-hint`, 'argument-hint' in fields);
    check(`${dir}: описание кончается "User-invoked as /${dir}."`, desc.endsWith(`User-invoked as /${dir}.`), desc.slice(-50));
  } else {
    check(`${dir}: авто-скилл без "User-invoked"`, !desc.includes('User-invoked'));
  }

  const lines = body.replace(/\n$/, '').split('\n').length;
  check(`${dir}: тело ≤130 строк`, lines <= 130, `lines=${lines}`);
}

// --- относительные ссылки из SKILL.md, reference/ и shared/ ---
function mdFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
    const p = path.join(dir, d.name);
    if (d.isDirectory()) return d.name === 'synced' ? [] : mdFiles(p);
    return d.name.endsWith('.md') ? [p] : [];
  });
}
const allMd = mdFiles(SKILLS);
for (const file of allMd) {
  const text = read(file);
  for (const [, target] of text.matchAll(/\]\(([^)\s#]+)(?:#[^)]*)?\)/g)) {
    if (/^[a-z]+:/.test(target)) continue;
    const resolved = path.resolve(path.dirname(file), target);
    check(`ссылка ${path.relative(SKILLS, file)} → ${target}`, fs.existsSync(resolved));
  }
}

// --- core.md: таблица грузит только существующие авто-скиллы ---
const core = read(path.join(HARNESS, 'rules', 'core.md'));
// До следующего заголовка, а не до его названия: раздел за таблицей переименовывали.
const tableStart = core.indexOf('## Skills');
const table = core.slice(tableStart, core.indexOf('\n## ', tableStart + 1));
const routed = new Set();
for (const row of table.split('\n').filter((l) => l.startsWith('|'))) {
  const cells = row.split('|');
  const loadCell = cells[cells.length - 2] || '';
  for (const [, name] of loadCell.matchAll(/`([a-z0-9-]+)`/g)) routed.add(name);
}
for (const name of routed) {
  check(`core.md: скилл ${name} существует`, skills.has(name));
  check(`core.md: ${name} не командный`, !skills.get(name)?.command);
}

// Каждый авто-скилл кем-то маршрутизирован: таблицей core.md или CLAUDE.md.
const claudeMd = read(path.join(HARNESS, 'claude', 'CLAUDE.md'));
for (const [dir, s] of skills) {
  if (s.command) continue;
  check(`${dir}: маршрут в core.md или CLAUDE.md`, routed.has(dir) || claudeMd.includes(`\`${dir}\``));
}

// --- командные скиллы: CLAUDE.md и OpenCode ---
const userInvoked = claudeMd.slice(claudeMd.indexOf('## User-invoked'));
const opencode = JSON.parse(read(path.join(HARNESS, 'opencode', 'opencode.json')));
const skillPerm = opencode.permission?.skill || {};
const ocCommands = path.join(HARNESS, 'opencode', 'command');
for (const [dir, s] of skills) {
  if (!s.command) continue;
  check(`${dir}: в строке user-invoked CLAUDE.md`, userInvoked.includes(`/${dir}`));
  const perm = skillPerm[dir];
  const ocCommand = fs.existsSync(path.join(ocCommands, `${dir}.md`));
  // Командный скилл в OpenCode либо закрыт, либо спрашивает и зовётся тонкой командой.
  check(`${dir}: OpenCode deny или ask + команда`, perm === 'deny' || (perm === 'ask' && ocCommand), `perm=${perm}, command=${ocCommand}`);
}
for (const f of fs.readdirSync(ocCommands).filter((n) => n.endsWith('.md'))) {
  for (const [, name] of read(path.join(ocCommands, f)).matchAll(/Load the `([a-z0-9-]+)` skill/g)) {
    check(`opencode/command/${f}: скилл ${name} существует`, skills.has(name));
  }
}

// --- test-browser только по команде пользователя ---
check('test-browser: disable-model-invocation', skills.get('test-browser')?.command === true);
const offerFiles = [...allMd.filter((f) => !f.includes(`${path.sep}test-browser${path.sep}`)), path.join(HARNESS, 'rules', 'core.md')];
for (const file of offerFiles) {
  check(`${path.relative(HARNESS, file)}: не зовёт test-browser`, !read(file).includes('test-browser') || file.endsWith('project-facts.md'));
}

// --- никаких фактов конкретного проекта ---
// Имена проектов — с этой машины, чтобы не вписывать их в тест: проект с
// непустой памятью Claude Code (`-home-u-main-web-groza` → `web-groza`).
const projectsDir = path.join(os.homedir(), '.claude', 'projects');
const projectNames = fs.existsSync(projectsDir)
  ? fs
      .readdirSync(projectsDir)
      .filter((d) => d.includes('-main-') && fs.existsSync(path.join(projectsDir, d, 'memory', 'MEMORY.md')))
      .map((d) => d.slice(d.indexOf('-main-') + '-main-'.length))
  : [];
// Публичные стандарты и сам tokensave — не факты проекта.
const ALLOWED_HOSTS = /github\.com\/aovestdipaperino|schema\.org|yandex\.(com|ru)|google\.com|claude\.(ai|com)/;
const PLACEHOLDER_TICKETS = new Set(['ABC-123']);
for (const file of [...allMd, path.join(HARNESS, 'rules', 'core.md')]) {
  const rel = path.relative(HARNESS, file);
  const text = read(file);
  const ticket = [...text.matchAll(/\b[A-Z][A-Z0-9]{1,9}-\d{2,}\b/g)].map((m) => m[0]).find((t) => !PLACEHOLDER_TICKETS.has(t));
  check(`${rel}: без номеров тикетов`, !ticket, ticket);
  const host = [...text.matchAll(/https?:\/\/[^\s)`'"]+/g)].map((m) => m[0]).find((u) => !ALLOWED_HOSTS.test(u) && !/<[a-z-]+>/.test(u));
  check(`${rel}: без реальных хостов`, !host, host);
  const project = projectNames.find((n) => new RegExp(`\\b${n.replace(/[-_]/g, '[-_]')}\\b`, 'i').test(text));
  check(`${rel}: без имён проектов`, !project, project);
}

// --- закрытые инструменты tokensave никто не советует ---
// field_sites паникует на не-ASCII исходнике и роняет весь сервер: совет из
// скилла или подсказки гарда превращал каждый impact-проход в падение MCP.
const settings = JSON.parse(read(path.join(HARNESS, 'claude', 'settings.json')));
const deniedTools = (settings.permissions?.deny || [])
  .filter((t) => t.startsWith('mcp__tokensave__tokensave_'))
  .map((t) => t.slice('mcp__tokensave__tokensave_'.length));
const ocPerm = opencode.permission || {};
const adviceFiles = [...allMd, path.join(HARNESS, 'rules', 'core.md'), path.join(HARNESS, 'ai-hooks', 'guard-core.mjs')];
for (const tool of deniedTools) {
  check(`${tool}: закрыт и в OpenCode`, ocPerm[`tokensave_tokensave_${tool}`] !== 'allow');
  for (const file of adviceFiles) {
    const advice = read(file).split('\n').find((l) => l.includes(tool) && !l.includes('denied'));
    check(`${path.relative(HARNESS, file)}: не советует ${tool}`, !advice, advice);
  }
}

process.stdout.write(failed ? `\n=== ${failed} проверок упало ===\n` : '\n=== все проверки прошли ===\n');
process.exit(failed ? 1 : 0);
