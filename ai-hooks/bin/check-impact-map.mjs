#!/usr/bin/env node
// Проверка карты неявных связей против рабочего дерева: каждая ссылка
// `путь:символ` разрешается в существующий файл и существующий символ, каждый
// глоб `paths:` во frontmatter файла домена совпадает хотя бы с одним файлом,
// индекс и файлы доменов сходятся, размеры в пределах контракта impact-map.md.
// Битая ссылка — это обычно удалённый модуль, строка которого его пережила;
// пустой глоб — переехавший каталог.
//
// Использование: check-impact-map.mjs [cwd] — проект берётся от cwd (git-корень).

import fs from 'node:fs';
import path from 'node:path';
import { repoRootOr } from '../state-core.mjs';

const INDEX_MAX = 30;
const ENTITY_MAX = 80;
// Каталоги карты: свой репозиторий и общий (там карта не коммитится).
const MAP_DIRS = ['docs/links', '.claude/links'];
const LEGACY = ['docs/implicit-links.md', '.claude/implicit-links.md'];
// Что не обходить, сверяя глобы с деревом: глоб на артефакт сборки — не связь.
const SKIP_DIRS = new Set(['.git', 'node_modules', 'dist', 'build', '.next', 'coverage']);

const root = repoRootOr(process.argv[2] || process.cwd());
const read = (p) => fs.readFileSync(p, 'utf8');
const lineCount = (text) => text.replace(/\n$/, '').split('\n').length;

const problems = [];
const report = (file, detail) => problems.push(`${path.relative(root, file)} — ${detail}`);

// Ссылка на код: путь со слэшем, расширением и необязательным `:символ`.
// Слэш обязателен — иначе именем файла выглядит имя события (`order.paid`).
// Плейсхолдеры вида `<feature>/Form.tsx` — примеры формата, а не ссылки.
const REF = /^([\w.-]+(?:\/[\w.-]+)+\.[A-Za-z][\w]*)(?::([A-Za-z_$][\w$]*))?$/;

// Ссылка на файл карты (`tracking/rls.md` из индекса или соседнего домена) —
// не ссылка на код: проверяется сверкой с индексом, а не как путь проекта.
function checkRefs(file, mapFiles = new Set()) {
  const text = read(file);
  for (const [, token] of text.matchAll(/`([^`\n]+)`/g)) {
    const m = token.match(REF);
    if (!m || token.includes('<') || mapFiles.has(token)) continue;
    const [, rel, symbol] = m;
    const target = path.join(root, rel);
    // Карту в общем репозитории пишет не только эта машина: `../../etc/passwd`
    // в строке связи не должен превращаться в чтение файла вне проекта.
    if (target !== root && !target.startsWith(root + path.sep)) {
      report(file, `ссылка за пределы проекта: ${rel}`);
      continue;
    }
    if (!fs.existsSync(target)) {
      report(file, `нет файла ${rel}`);
      continue;
    }
    if (!symbol) continue;
    if (!new RegExp(`\\b${symbol.replace(/\$/g, '\\$')}\\b`).test(read(target))) {
      report(file, `в ${rel} нет символа ${symbol}`);
    }
  }
  return text;
}

// Frontmatter файла домена в формате .claude/rules: `paths:` и список глобов.
// Нет frontmatter или нет `paths:` → null: файл достижим только через индекс.
function pathsOf(text) {
  const m = text.match(/^---\n([\s\S]*?)\n---\n/);
  if (!m) return null;
  const lines = m[1].split('\n');
  const start = lines.findIndex((l) => /^paths:\s*$/.test(l));
  if (start < 0) return null;
  const globs = [];
  for (const line of lines.slice(start + 1)) {
    const item = line.match(/^\s+-\s+["']?([^"'#]+?)["']?\s*$/);
    if (!item) break;
    globs.push(item[1]);
  }
  return globs;
}

// Файлы рабочего дерева относительно корня, со слэшами вперёд — как в глобах.
let treeFiles;
function tree() {
  if (treeFiles) return treeFiles;
  treeFiles = [];
  const walk = (dir, rel) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const child = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) walk(path.join(dir, entry.name), child);
      } else {
        treeFiles.push(child);
      }
    }
  };
  walk(root, '');
  return treeFiles;
}

function checkPaths(file, text) {
  const globs = pathsOf(text);
  if (globs === null) return;
  if (!globs.length) report(file, 'paths: пустой — убрать frontmatter или назвать каталоги');
  for (const glob of globs) {
    if (!tree().some((f) => path.matchesGlob(f, glob))) {
      report(file, `paths: глоб ${glob} не совпал ни с одним файлом`);
    }
  }
}

const mapDir = MAP_DIRS.map((d) => path.join(root, d)).find((d) => fs.existsSync(d));
if (!mapDir) {
  const legacy = LEGACY.map((f) => path.join(root, f)).find((f) => fs.existsSync(f));
  if (!legacy) {
    process.stdout.write(`карта: в ${root} её нет — проверять нечего\n`);
    process.exit(0);
  }
  checkRefs(legacy);
  const lines = lineCount(read(legacy));
  report(legacy, `плоская карта на ${lines} строк — разбить на INDEX.md и файлы сущностей`);
} else {
  const indexFile = path.join(mapDir, 'INDEX.md');
  if (!fs.existsSync(indexFile)) {
    report(mapDir, 'нет INDEX.md');
  }

  // Файлы доменов: `tracking.md` или `tracking/rls.md`, когда домен разбит.
  const domains = fs
    .readdirSync(mapDir, { recursive: true })
    .map((n) => n.split(path.sep).join('/'))
    .filter((n) => n.endsWith('.md') && n !== 'INDEX.md')
    .sort();
  const domainSet = new Set(domains);
  // Разбитый домен — каталог вместо файла, а не рядом с ним.
  for (const name of domains) {
    const parent = `${name.split('/')[0]}.md`;
    if (name.includes('/') && domainSet.has(parent)) {
      report(path.join(mapDir, parent), `домен разбит на каталог ${name.split('/')[0]}/ — родительский файл удалить`);
    }
  }

  if (fs.existsSync(indexFile)) {
    const index = checkRefs(indexFile, domainSet);
    const indexLines = lineCount(index);
    if (indexLines > INDEX_MAX) report(indexFile, `${indexLines} строк > ${INDEX_MAX}`);
    // Имя домена — файл карты без пути или `каталог/файл.md`, где каталог лежит
    // в карте; иной путь со слэшем — ссылка на документ проекта (checkRefs).
    const listed = new Set(
      [...index.matchAll(/`([\w.-]+(?:\/[\w.-]+)*\.md)`/g)]
        .map((m) => m[1])
        .filter((n) => !n.includes('/') || fs.existsSync(path.join(mapDir, n.split('/')[0]))),
    );
    for (const name of domains) {
      if (!listed.has(name)) report(indexFile, `домен ${name} не указан в индексе`);
    }
    for (const name of listed) {
      if (!domainSet.has(name)) report(indexFile, `в индексе ${name}, а файла нет`);
    }
  }

  for (const name of domains) {
    const file = path.join(mapDir, name);
    const text = checkRefs(file, domainSet);
    checkPaths(file, text);
    const lines = lineCount(text);
    if (lines > ENTITY_MAX) report(file, `${lines} строк > ${ENTITY_MAX} — разбить домен на каталог`);
  }
}

if (!problems.length) {
  process.stdout.write(`карта: ${path.relative(root, mapDir || root)} — все ссылки разрешились\n`);
  process.exit(0);
}
process.stdout.write(`карта: ${problems.length} замечаний\n${problems.map((p) => `  ${p}`).join('\n')}\n`);
process.exit(1);
