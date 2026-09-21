#!/usr/bin/env node
// Подмена `tokensave tool search --args <json> --json` для теста seed-impact-map:
// буквальный поиск по файлам cwd с `enclosing`, как у настоящего индекса —
// имя функции/метода, а для строки-декоратора имя самого декоратора.
// FAKE_TOKENSAVE_MAX_CHARS воспроизводит обрезание ответа бинарём.
import fs from 'node:fs';
import path from 'node:path';

const argsAt = process.argv.indexOf('--args');
const { query, path_include = [], path_exclude = [] } = JSON.parse(process.argv[argsAt + 1]);
const root = process.cwd();

function* files(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith('.') || e.name === 'node_modules') continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) yield* files(full);
    else yield path.relative(root, full);
  }
}

const matches = [];
for (const rel of files(root)) {
  if (path_include.length && !path_include.some((p) => rel.includes(p))) continue;
  if (path_exclude.some((p) => rel.includes(p))) continue;
  let enclosing = rel;
  fs.readFileSync(path.join(root, rel), 'utf8').split('\n').forEach((text, i) => {
    // Верхний уровень и методы класса; `const` внутри функции — не символ.
    const def = text.match(/^(?:export\s+)?(?:async\s+)?(?:function|const|class)\s+([\w$]+)/)
      || text.match(/^\s{2}(?:async\s+)?([\w$]+)\s*\(/);
    if (def) enclosing = def[1];
    if (!text.includes(query)) return;
    const decorator = text.match(/^\s*@(\w+)\(/);
    matches.push({ file: rel, line: i + 1, text, enclosing: decorator ? decorator[1] : enclosing });
  });
}

let text = JSON.stringify({ literal: true, query, count: matches.length, matches }, null, 2);
const cap = Number(process.env.FAKE_TOKENSAVE_MAX_CHARS || 0);
if (cap && text.length > cap) text = `${text.slice(0, cap)}\n\n[... truncated at ${cap} chars]`;
process.stdout.write(JSON.stringify({ content: [{ type: 'text', text }] }));
