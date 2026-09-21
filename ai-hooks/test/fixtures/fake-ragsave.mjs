#!/usr/bin/env node
// Подмена `ragsave search <query> <root> -n <N> --outside --json` для теста
// seed-impact-map: строки файлов вне индекса tokensave (не код и не markdown)
// с точным вхождением запроса — чанком из двух строк, как у настоящего индекса,
// плюс первая строка каждого файла без вхождения: гибридный поиск всегда
// отдаёт смысловых соседей, и скрипт обязан их отсеять.
import fs from 'node:fs';
import path from 'node:path';

const [, , , query, root] = process.argv;
const INSIDE_RE = /\.(m?[jt]sx?|md)$/;

function* files(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory() && (e.name.startsWith('.') || e.name === 'node_modules')) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) yield* files(full);
    else yield path.relative(root, full);
  }
}

const hits = [];
const neighbours = [];
for (const rel of files(root)) {
  if (INSIDE_RE.test(rel)) continue;
  const lines = fs.readFileSync(path.join(root, rel), 'utf8').split('\n');
  let found = false;
  lines.forEach((text, i) => {
    if (!text.includes(query)) return;
    found = true;
    const start = Math.max(0, i - 1);
    hits.push({ path: rel, start_line: start + 1, end_line: i + 1, score: 0.03, in_tokensave: false, text: lines.slice(start, i + 1).join('\n') });
  });
  if (!found) neighbours.push({ path: rel, start_line: 1, end_line: 1, score: 0.01, in_tokensave: false, text: lines[0] });
}

const all = [...hits, ...neighbours];
// Пустой ответ бинарь печатает строкой и с `--json`.
process.stdout.write(all.length ? JSON.stringify(all, null, 2) : 'Ничего не найдено.\n');
