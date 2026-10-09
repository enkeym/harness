#!/usr/bin/env node
// Тесты bin/log-error.sh — общей записи отказов фоновых задач в errors.log:
// формат записи, чистка хвоста лога от ANSI и спиннера, предел строк и длины,
// пропуск конкурентного sync (строка tokensave, код 3 ragsave), ротация по
// размеру, код 0 при любом исходе.

import './env-isolate.mjs';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SCRIPT = path.join(ROOT, 'bin', 'log-error.sh');

let failed = 0;
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  process.stdout.write(`${ok ? 'ok  ' : 'FAIL'} ${name} (got=${JSON.stringify(got)}, want=${JSON.stringify(want)})\n`);
  if (!ok) failed++;
}

function sandbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'log-error-'));
  const logDir = path.join(dir, 'logs');
  const errors = path.join(logDir, 'errors.log');
  const run = (...args) => spawnSync('bash', [SCRIPT, ...args], { encoding: 'utf8', env: { ...process.env, AI_HOOKS_LOG_DIR: logDir } });
  const detail = (text) => {
    const file = path.join(dir, `detail-${Math.random().toString(36).slice(2)}.log`);
    fs.writeFileSync(file, text);
    return file;
  };
  const read = () => (fs.existsSync(errors) ? fs.readFileSync(errors, 'utf8') : '');
  return { dir, logDir, errors, run, detail, read };
}

// --- запись без лога подробностей ---
{
  const sb = sandbox();
  const res = sb.run('tokensave sync', '/work/p', '', '3');
  check('код 0', res.status, 0);
  check('заголовок: время, источник, проект, код, разделитель',
    /^\[\d{4}-\d\d-\d\d \d\d:\d\d:\d\d\] tokensave sync \| \/work\/p \| exit=3\n---\n$/.test(sb.read()), true);
}

// --- без аргументов ---
{
  const sb = sandbox();
  sb.run();
  check('без аргументов — заглушки unknown / ? / ?', /\] unknown \| \? \| exit=\?\n---\n$/.test(sb.read()), true);
}

// --- хвост лога ---
{
  const sb = sandbox();
  const lines = Array.from({ length: 40 }, (_, i) => `line ${i + 1}`);
  const log = sb.detail([
    ...lines,
    '',
    '   ',
    '\x1b[2K\x1b[1Gcopying DB⠋copying DB⠙error: disk full',
    'dup', 'dup',
    'x'.repeat(300),
  ].join('\n'));
  sb.run('ragsave sync', '/work/p', log, '1');
  const body = sb.read().split('\n').slice(1, -2);

  check('строки с отступом в 4 пробела', body.every((l) => l.startsWith('    ')), true);
  check('ANSI вычищен', body.some((l) => l.includes('\x1b')), false);
  check('спиннер разбит на строки, ошибка видна отдельно', body.includes('    error: disk full'), true);
  check('пустые строки выброшены', body.some((l) => !l.trim()), false);
  check('повторы подряд схлопнуты', body.filter((l) => l === '    dup').length, 1);
  check('строка обрезана до 200 символов', body.at(-1), `    ${'x'.repeat(200)}`);
  check('старые строки за пределами хвоста не попали', body.includes('    line 1'), false);
}

// --- предел хвоста ---
{
  const sb = sandbox();
  sb.run('ragsave sync', '/work/p', sb.detail(Array.from({ length: 40 }, (_, i) => `line ${i + 1}`).join('\n')), '1');
  const body = sb.read().split('\n').slice(1, -2);
  check('последние 25 строк', [body.length, body[0], body.at(-1)], [25, '    line 16', '    line 40']);
}

// --- конкурентный sync ---
{
  const sb = sandbox();
  const res = sb.run('tokensave sync', '/work/p', sb.detail('error: another sync is already in progress\n'), '1');
  check('конкурентный sync — код 0 и без записи', [res.status, sb.read()], [0, '']);
}

// --- ragsave: занятый замок по коду 3, строка в логе не нужна ---
{
  const sb = sandbox();
  const res = sb.run('ragsave sync', '/work/p', sb.detail('чужой вывод следующего прохода\n'), '3');
  check('ragsave код 3 без строки — код 0 и без записи', [res.status, sb.read()], [0, '']);

  sb.run('ragsave sync', '/work/p', sb.detail('ragsave: синк отменён\n'), '4');
  check('ragsave код 4 (ragsave cancel) — без записи', sb.read(), '');

  sb.run('ragsave sync', '/work/p', sb.detail('Traceback\n'), '1');
  check('ragsave код 1 — запись есть', /ragsave sync \| \/work\/p \| exit=1\n/.test(sb.read()), true);

  const other = sandbox();
  other.run('tokensave sync', '/work/p', '', '3');
  check('tokensave код 3 без строки — запись есть', /tokensave sync \| \/work\/p \| exit=3\n/.test(other.read()), true);
}

// --- лог подробностей указан, но его нет ---
{
  const sb = sandbox();
  sb.run('tokensave sync', '/work/p', path.join(sb.dir, 'missing.log'), '2');
  check('лога нет — только заголовок', /exit=2\n---\n$/.test(sb.read()) && sb.read().split('\n').length === 3, true);
}

// --- ротация ---
{
  const sb = sandbox();
  fs.mkdirSync(sb.logDir, { recursive: true });
  fs.writeFileSync(sb.errors, Buffer.alloc(5 * 1024 * 1024 + 1, 'a'));
  sb.run('tokensave sync', '/work/new', '', '1');
  check('больше 5 МБ — прошлый файл в .1', fs.statSync(`${sb.errors}.1`).size, 5 * 1024 * 1024 + 1);
  check('новый файл — только свежая запись', /^\[.*\/work\/new \| exit=1\n---\n$/.test(sb.read()), true);

  sb.run('tokensave sync', '/work/next', '', '1');
  check('маленький файл не ротируется', sb.read().split('---\n').length - 1, 2);
}

// --- каталог журнала создать нельзя ---
{
  const sb = sandbox();
  fs.writeFileSync(path.join(sb.dir, 'blocker'), '');
  const res = spawnSync('bash', [SCRIPT, 'x', '/p', '', '1'], {
    encoding: 'utf8', env: { ...process.env, AI_HOOKS_LOG_DIR: path.join(sb.dir, 'blocker', 'logs') },
  });
  check('каталог не создаётся — тихий код 0', [res.status, res.stderr], [0, '']);
}

process.stdout.write(failed ? `\n=== ${failed} проверок упало ===\n` : '\n=== все проверки прошли ===\n');
process.exit(failed ? 1 : 0);
