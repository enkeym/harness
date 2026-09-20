#!/usr/bin/env node
// Проверка карты неявных связей против рабочего дерева: каждая ссылка
// `путь:символ` разрешается в существующий файл и существующий символ, индекс
// и файлы сущностей сходятся, размеры в пределах контракта impact-map.md.
// Битая ссылка — это обычно удалённый модуль, строка которого его пережила.
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

const root = repoRootOr(process.argv[2] || process.cwd());
const read = (p) => fs.readFileSync(p, 'utf8');
const lineCount = (text) => text.replace(/\n$/, '').split('\n').length;

const problems = [];
const report = (file, detail) => problems.push(`${path.relative(root, file)} — ${detail}`);

// Ссылка на код: путь со слэшем, расширением и необязательным `:символ`.
// Слэш обязателен — иначе именем файла выглядит имя события (`order.paid`).
// Плейсхолдеры вида `<feature>/Form.tsx` — примеры формата, а не ссылки.
const REF = /^([\w.-]+(?:\/[\w.-]+)+\.[A-Za-z][\w]*)(?::([A-Za-z_$][\w$]*))?$/;

function checkRefs(file) {
  const text = read(file);
  for (const [, token] of text.matchAll(/`([^`\n]+)`/g)) {
    const m = token.match(REF);
    if (!m || token.includes('<')) continue;
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

  const entities = fs
    .readdirSync(mapDir)
    .filter((n) => n.endsWith('.md') && n !== 'INDEX.md')
    .sort();

  if (fs.existsSync(indexFile)) {
    const index = checkRefs(indexFile);
    const indexLines = lineCount(index);
    if (indexLines > INDEX_MAX) report(indexFile, `${indexLines} строк > ${INDEX_MAX}`);
    // Ссылки индекса на файлы сущностей и обратное покрытие.
    const listed = new Set([...index.matchAll(/`([\w./-]+\.md)`/g)].map((m) => path.basename(m[1])));
    for (const name of entities) {
      if (!listed.has(name)) report(indexFile, `сущность ${name} не указана в индексе`);
    }
    for (const name of listed) {
      if (!entities.includes(name)) report(indexFile, `в индексе ${name}, а файла нет`);
    }
  }

  for (const name of entities) {
    const file = path.join(mapDir, name);
    const lines = lineCount(checkRefs(file));
    if (lines > ENTITY_MAX) report(file, `${lines} строк > ${ENTITY_MAX} — выделить под-сущность`);
  }
}

if (!problems.length) {
  process.stdout.write(`карта: ${path.relative(root, mapDir || root)} — все ссылки разрешились\n`);
  process.exit(0);
}
process.stdout.write(`карта: ${problems.length} замечаний\n${problems.map((p) => `  ${p}`).join('\n')}\n`);
process.exit(1);
