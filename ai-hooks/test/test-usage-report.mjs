#!/usr/bin/env node
// Тесты отчёта /usage (bin/usage-report.mjs) по logs/usage.jsonl: период
// (--days, --today) и фильтр --project отбирают сессии; суммы по моделям и
// проектам складываются (подкаталоги одного git-репозитория — один
// проект), cache write — из обоих кэшей, модель без цены
// помечена; источники контекста — в ~токенах; без файла и без сессий за
// период — понятная строка, а не падение.

import './env-isolate.mjs';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const REPORT = path.join(ROOT, 'bin', 'usage-report.mjs');

let failed = 0;
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  process.stdout.write(`${ok ? 'ok  ' : 'FAIL'} ${name} (got=${JSON.stringify(got)}, want=${JSON.stringify(want)})\n`);
  if (!ok) failed++;
}

// usage.jsonl лежит под HOME — отчёт видит только песочницу.
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-report-'));
const logDir = path.join(home, '.ai-hooks', 'logs');
const env = { ...process.env, HOME: home };

const run = (...args) => spawnSync('node', [REPORT, ...args], { encoding: 'utf8', env });
const report = (...args) => run(...args).stdout;

const DAY = 24 * 3600 * 1000;
const ago = (ms) => new Date(Date.now() - ms).toISOString();

function session(extra) {
  return {
    session_id: `s-${Math.random().toString(36).slice(2)}`,
    project: path.join(home, 'work', 'alpha'),
    ended: ago(0),
    cost: 1,
    subagents: 0,
    models: {},
    tools: {},
    ...extra,
  };
}

const model = (extra) => ({ input: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0, output: 0, cost: 0, ...extra });

// --- аргументы: неверный — использование и код 1, а не отчёт за другой период ---
{
  const help = run('--help');
  check('--help — использование, код 0', [help.status, help.stdout.startsWith('Запуск:')], [0, true]);
  for (const args of [['--weeks', '2'], ['--days', 'abc'], ['--days', '0'], ['--days'], ['30']]) {
    const r = run(...args);
    check(`${args.join(' ')} — использование в stderr, код 1`, [r.status, r.stdout, r.stderr.startsWith('Запуск:')], [1, '', true]);
  }
}

// --- файла ещё нет ---
check('без usage.jsonl — «Нет данных»', report().startsWith('Нет данных:'), true);

fs.mkdirSync(logDir, { recursive: true });
fs.mkdirSync(path.join(home, 'work', 'alpha', '.git'), { recursive: true });
const records = [
  session({
    ended: ago(0), cost: 1.5, subagents: 2,
    models: { 'claude-opus-5': model({ input: 1000, cacheRead: 2000, cacheWrite5m: 300, cacheWrite1h: 200, output: 500, cost: 1.5 }) },
    tools: { Read: 5, Bash: 2 },
    context_sources: { tools: { Read: { calls: 5, chars: 40_000 } }, files: { [path.join(home, 'work', 'alpha', 'big.ts')]: 40_000 } },
  }),
  session({
    ended: ago(2 * DAY), cost: 0.5, project: path.join(home, 'work', 'alpha', 'packages', 'api'),
    models: { 'claude-opus-5': model({ input: 1000, output: 500, cost: 0.5 }), 'mystery-model': model({ input: 10, priced: false }) },
    tools: { Read: 1, Edit: 3 },
  }),
  session({ ended: ago(2 * DAY), cost: 3, project: path.join(home, 'work', 'beta') }),
  session({ ended: ago(10 * DAY), cost: 100 }),
  session({ ended: null, cost: 100 }),
];
fs.writeFileSync(path.join(logDir, 'usage.jsonl'), `${records.map((r) => JSON.stringify(r)).join('\n')}\n`);

// --- период ---
const week = report();
check('7 дней: старая и незавершённая сессии не считаются',
  week.split('\n')[0], 'Период: 7 дн. · сессий: 3 · субагентов: 2 · оценка стоимости: $5.00');
check('--days 30 берёт и старую', report('--days', '30').split('\n')[0].includes('сессий: 4'), true);
check('--today — только сегодняшняя', report('--today').split('\n')[0],
  'Период: сегодня · сессий: 1 · субагентов: 2 · оценка стоимости: $1.50');

// --- проекты ---
check('--project фильтрует по подстроке пути', report('--project', 'beta').split('\n')[0].includes('сессий: 1'), true);
check('--project без совпадений — «Сессий за период нет»', report('--project', 'nope'), 'Сессий за период нет.\n');
check('проект — git-корень от ~ (вне git — путь как есть), отсортирован по цене',
  week.split('\n').filter((l) => l.includes('сес.')).map((l) => l.trim().split(/\s+/).slice(0, 2)),
  [['~/work/beta', '1'], ['~/work/alpha', '2']]);
check('--project — по подстроке пути сессии, не корня', report('--project', 'packages').split('\n')[0].includes('сессий: 1'), true);

// --- модели ---
const opus = week.split('\n').find((l) => l.trim().startsWith('claude-opus-5')).trim().split(/\s+/);
check('модель: суммы input / cache read / cache write (5m+1h) / output / $', opus, ['claude-opus-5', '2.0k', '2.0k', '500', '1.0k', '$2.00']);
check('модель без цены помечена', week.split('\n').find((l) => l.includes('mystery-model')).includes('(нет цены)'), true);

// --- инструменты и источники ---
const toolLines = week.split('Инструменты')[1].split('\n\n')[0].split('\n').slice(1).map((l) => l.trim().split(/\s+/));
check('инструменты сложены и отсортированы', toolLines, [['Read', '6'], ['Edit', '3'], ['Bash', '2']]);
check('источник: вызовы и ~токены (символы / 4)',
  week.split('\n').find((l) => l.includes('Read') && l.includes('10.0k')).trim().split(/\s+/), ['Read', '5', '10.0k']);
check('тяжёлый файл показан от ~', week.includes('~/work/alpha/big.ts'), true);

// --- по сессиям ---
check('без --sessions списка нет', week.includes('Сессии:'), false);
const rows = report('--sessions').split('Сессии:\n')[1].trim().split('\n');
check('--sessions: по строке на сессию, старые первыми', [rows.length, rows[2].includes('~/work/alpha')], [3, true]);
check('--sessions: модели без префикса claude-', rows[2].trim().endsWith('opus-5'), true);

fs.rmSync(home, { recursive: true, force: true });
process.stdout.write(failed ? `\n=== ${failed} проверок упало ===\n` : '\n=== все проверки прошли ===\n');
process.exit(failed ? 1 : 0);
