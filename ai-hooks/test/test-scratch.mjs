#!/usr/bin/env node
// Тесты уборки черновиков в /tmp: настоящий хук claude/scratch.mjs, два
// события — PreToolUse запоминает, SessionEnd удаляет. Главное — удалить
// только созданное агентом: чужой файл в /tmp, репозиторий в /tmp и каталог
// Claude Code остаются.

import './env-isolate.mjs';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { recordScratch, removeScratch } from '../scratch-core.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const HOOK = path.join(ROOT, 'claude', 'scratch.mjs');

let failed = 0;
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  process.stdout.write(`${ok ? 'ok  ' : 'FAIL'} ${name} (got=${JSON.stringify(got)}, want=${JSON.stringify(want)})\n`);
  if (!ok) failed++;
}

function hook(input) {
  return execFileSync('node', [HOOK], { input: JSON.stringify(input), encoding: 'utf8' });
}
const pre = (sid, tool_name, tool_input) => hook({ hook_event_name: 'PreToolUse', session_id: sid, tool_name, tool_input });
const end = (sid) => hook({ hook_event_name: 'SessionEnd', session_id: sid, reason: 'clear' });

// os.tmpdir() под env-isolate — каталог внутри /tmp.
const BOX = fs.mkdtempSync(path.join(os.tmpdir(), 'scratch-'));
const at = (name) => path.join(BOX, name);

// --- 1. Вывод команды в новый файл — удалён в конце сессии, хук молчит
{
  const out = pre('s1', 'Bash', { command: `npm run build > ${at('build.log')} 2>&1; tail -3 ${at('build.log')}` });
  check('хук молчит', out, '');
  fs.writeFileSync(at('build.log'), 'log');
  end('s1');
  check('лог сборки удалён', fs.existsSync(at('build.log')), false);
}

// --- 2. Существовавший до вызова файл не трогается
{
  fs.writeFileSync(at('user.txt'), 'чужое');
  pre('s2', 'Bash', { command: `tail ${at('user.txt')} > ${at('copy.txt')}` });
  fs.writeFileSync(at('copy.txt'), 'x');
  end('s2');
  check('чужой файл на месте', fs.existsSync(at('user.txt')), true);
  check('созданная копия удалена', fs.existsSync(at('copy.txt')), false);
}

// --- 3. Write — тоже черновик
{
  pre('s3', 'Write', { file_path: at('review.md') });
  fs.writeFileSync(at('review.md'), '# отчёт');
  end('s3');
  check('файл Write удалён', fs.existsSync(at('review.md')), false);
}

// --- 4. Каталог: пустой уходит, с чужим содержимым остаётся
{
  pre('s4', 'Bash', { command: `mkdir -p ${at('d1')} ${at('d2')} && git diff > ${at('d1')}/a.patch` });
  fs.mkdirSync(at('d1'));
  fs.mkdirSync(at('d2'));
  fs.writeFileSync(path.join(at('d1'), 'a.patch'), 'p');
  fs.writeFileSync(path.join(at('d2'), 'unnamed.bin'), 'b');
  end('s4');
  check('каталог с названным файлом удалён', fs.existsSync(at('d1')), false);
  check('каталог с неназванным файлом остался', fs.existsSync(path.join(at('d2'), 'unnamed.bin')), true);
}

// --- 5. Чужая сессия не убирает файлы этой
{
  pre('s5', 'Bash', { command: `echo x > ${at('mine.txt')}` });
  fs.writeFileSync(at('mine.txt'), 'x');
  end('other');
  check('файл другой сессии на месте', fs.existsSync(at('mine.txt')), true);
  end('s5');
  check('своя сессия убрала', fs.existsSync(at('mine.txt')), false);
}

// --- 6. Не записываются: репозиторий в /tmp, каталог Claude Code, выражения, пути вне /tmp
{
  const repo = at('repo');
  fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
  check('файл репозитория в /tmp', recordScratch('s6', 'Bash', { command: `echo > ${repo}/new.ts` }), 0);
  check('каталог Claude Code', recordScratch('s6', 'Bash', { command: 'cat /tmp/claude-1000/x/tasks/a.output' }), 0);
  check('путь с переменной и glob', recordScratch('s6', 'Bash', { command: `echo > /tmp/$X.log; ls ${BOX}/*.log` }), 0);
  check('путь вне /tmp', recordScratch('s6', 'Write', { file_path: path.join(ROOT, 'nope.txt') }), 0);
  check('без сессии', recordScratch('', 'Bash', { command: `echo > ${at('n.txt')}` }), 0);
  check('пустой список — ноль', removeScratch('s6'), 0);
}

// --- 7. Файл, не созданный за сессию, — ноль удалений и без падения
{
  pre('s7', 'Bash', { command: `echo > ${at('never.txt')}` });
  let crashed = false;
  try { end('s7'); } catch { crashed = true; }
  check('несозданный файл не роняет', crashed, false);
}

fs.rmSync(BOX, { recursive: true, force: true });
process.stdout.write(failed ? `\n=== ${failed} FAIL ===\n` : '\n=== все проверки прошли ===\n');
process.exit(failed ? 1 : 0);
