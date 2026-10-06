#!/usr/bin/env node
// Тесты доли инструментов (bin/tool-share.mjs): граница делит сессии на «до» и
// «после»; неверная граница или размер — использование и код 1, а не молча
// весь отчёт по одну сторону границы; запись <synthetic> (без вызова API) не
// ответ — не в turns и не в модель; сессии из самого HOME подписаны ~.

import './env-isolate.mjs';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SCRIPT = path.join(ROOT, 'bin', 'tool-share.mjs');

let failed = 0;
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  process.stdout.write(`${ok ? 'ok  ' : 'FAIL'} ${name} (got=${JSON.stringify(got)}, want=${JSON.stringify(want)})\n`);
  if (!ok) failed++;
}

// Транскрипты лежат под HOME/.claude/projects — скрипт видит только песочницу.
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tool-share-'));
const homeDir = path.join(home, '.claude', 'projects', home.replace(/[^a-zA-Z0-9]/g, '-'));
const projDir = `${homeDir}-demo`;
fs.mkdirSync(projDir, { recursive: true });
fs.mkdirSync(homeDir, { recursive: true });

const assistant = (timestamp) => ({
  type: 'assistant', timestamp,
  message: { model: 'claude-opus-5', usage: { input_tokens: 1000 }, content: [{ type: 'tool_use', name: 'Read', input: {} }] },
});
const synthetic = (timestamp) => ({
  type: 'assistant', timestamp,
  message: { model: '<synthetic>', usage: { input_tokens: 0 }, content: [{ type: 'text', text: 'No response requested.' }] },
});
const write = (dir, name, recs) => fs.writeFileSync(path.join(dir, name), `${recs.map((r) => JSON.stringify(r)).join('\n')}\n`);
write(projDir, 'aaaaaaaa-1.jsonl', [synthetic('2026-09-01T09:59:00.000Z'), assistant('2026-09-01T10:00:00.000Z')]);
write(projDir, 'bbbbbbbb-2.jsonl', [assistant('2026-09-30T10:00:00.000Z')]);
write(homeDir, 'cccccccc-3.jsonl', [assistant('2026-09-30T11:00:00.000Z')]);

const run = (...args) => spawnSync('node', [SCRIPT, ...args], { encoding: 'utf8', env: { ...process.env, HOME: home } });
// Строки итога «всего до» / «всего после» → число сессий в каждой.
const totals = (out) => Object.fromEntries(out.split('\n').filter((l) => l.startsWith('всего '))
  .map((l) => l.split('\t')).map(([label, n]) => [label, n]));

// Строки сессий: шапка до пустой строки → объекты по колонкам.
const rows = (out) => {
  const [head, ...lines] = out.split('\n\n')[0].trim().split('\n').map((l) => l.split('\t'));
  return lines.map((r) => Object.fromEntries(head.map((h, i) => [h, r[i]])));
};

// --- <synthetic> ---
{
  const [first] = rows(run('2026-09-15', '0').stdout);
  check('<synthetic> не в turns и не в модели', [first.file, first.turns, first.model], ['aaaaaaaa', '1', 'opus-5']);
}

// --- проект ---
check('сам каталог HOME — ~, префикс HOME срезан', rows(run('2026-09-15', '0').stdout).map((r) => r.proj), ['-demo', '-demo', '~']);

// --- граница ---
check('граница делит сессии', totals(run('2026-09-15', '0').stdout), { 'всего до': '1 сессий', 'всего после': '2 сессий' });
check('граница со временем в Z', totals(run('2026-09-30T12:00:00Z', '0').stdout), { 'всего до': '3 сессий' });

// --- аргументы ---
const help = run('--help');
check('--help — использование, код 0', [help.status, help.stdout.startsWith('Запуск:')], [0, true]);
for (const args of [['yesterday'], ['2026-09-15T10:00:00+03:00'], ['2026-13-45'], ['2026-09-15', 'abc']]) {
  const r = run(...args);
  check(`${args.join(' ')} — использование в stderr, код 1`, [r.status, r.stdout, r.stderr.startsWith('Запуск:')], [1, '', true]);
}

fs.rmSync(home, { recursive: true, force: true });
process.stdout.write(failed ? `\n=== ${failed} проверок упало ===\n` : '\n=== все проверки прошли ===\n');
process.exit(failed ? 1 : 0);
