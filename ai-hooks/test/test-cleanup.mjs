#!/usr/bin/env node
// Тесты уборщика. Проверяется то, что при ошибке теряется молча: свёртка
// журнала расходов не должна ни терять деньги, ни удваивать их при повторном
// проходе, а --dry-run обязан быть безвредным. Файловая часть гоняется на
// временном HOME, чтобы тест не трогал настоящее состояние.

import './env-isolate.mjs';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SCRIPT = path.join(ROOT, 'bin', 'cleanup.mjs');
const DAY = 86400 * 1000;

let failed = 0;
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  process.stdout.write(`${ok ? 'ok  ' : 'FAIL'} ${name} (got=${JSON.stringify(got)}, want=${JSON.stringify(want)})\n`);
  if (!ok) failed++;
}

// Песочница: свой HOME, свои каталоги состояния.
function sandbox() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cleanup-test-'));
  fs.mkdirSync(path.join(home, '.ai-hooks', 'logs'), { recursive: true });
  fs.mkdirSync(path.join(home, '.claude', 'telemetry'), { recursive: true });
  return home;
}

function run(home, args = []) {
  return execFileSync('node', [SCRIPT, ...args], {
    encoding: 'utf8',
    env: { ...process.env, HOME: home, AI_HOOKS_STATE_DIR: '' },  // состояние — под HOME песочницы
  });
}

function aged(file, days, content = 'x') {
  fs.writeFileSync(file, content);
  const t = (Date.now() - days * DAY) / 1000;
  fs.utimesSync(file, t, t);
}

function session(id, endedDaysAgo, cost, model = 'claude-sonnet-5') {
  return {
    session_id: id,
    project: '/home/enkeym/main/vpn-new',
    ended: new Date(Date.now() - endedDaysAgo * DAY).toISOString(),
    updated: new Date(Date.now() - endedDaysAgo * DAY).toISOString(),
    subagents: 1,
    cost,
    models: { [model]: { input: 100, cacheRead: 200, cacheWrite5m: 50, cacheWrite1h: 0, output: 300, messages: 5, cost, priced: true } },
    tools: { Bash: 3 },
  };
}

const usagePath = (home) => path.join(home, '.ai-hooks', 'logs', 'usage.jsonl');
const readUsage = (home) => fs.readFileSync(usagePath(home), 'utf8').split('\n').filter(Boolean).map(JSON.parse);
const totalCost = (recs) => Math.round(recs.reduce((s, r) => s + (r.cost || 0), 0) * 10000) / 10000;

// --- 1. Свёртка не теряет деньги
{
  const home = sandbox();
  const recs = [session('a', 200, 1.5), session('b', 150, 2.25), session('c', 10, 0.5)];
  fs.writeFileSync(usagePath(home), recs.map((r) => JSON.stringify(r)).join('\n') + '\n');
  const before = totalCost(recs);
  run(home, ['--force']);
  const after = readUsage(home);
  check('свёртка сохраняет сумму', totalCost(after), before);
  check('свежая запись осталась подробной', after.filter((r) => r.session_id === 'c').length, 1);
  check('старые свёрнуты', after.filter((r) => r.rollup).length, 2);
  // Разные месяцы дают по строке на месяц — длина файла может не измениться,
  // но подробности старых сессий должны исчезнуть. Это и есть смысл свёртки.
  check('старые потеряли детализацию', after.some((r) => r.session_id === 'a' || r.session_id === 'b'), false);
  fs.rmSync(home, { recursive: true, force: true });
}

// --- 2. Повторный проход не удваивает
{
  const home = sandbox();
  const recs = [session('a', 200, 1.5), session('b', 200, 2.5), session('c', 5, 0.25)];
  fs.writeFileSync(usagePath(home), recs.map((r) => JSON.stringify(r)).join('\n') + '\n');
  run(home, ['--force']);
  const once = readUsage(home);
  run(home, ['--force']);
  run(home, ['--force']);
  const thrice = readUsage(home);
  check('идемпотентность: сумма не растёт', totalCost(thrice), totalCost(once));
  check('идемпотентность: записей столько же', thrice.length, once.length);
  fs.rmSync(home, { recursive: true, force: true });
}

// --- 3. Свёртка складывает по месяцам, а не в одну кучу
{
  const home = sandbox();
  fs.writeFileSync(usagePath(home), [session('a', 200, 1), session('b', 400, 2)].map((r) => JSON.stringify(r)).join('\n') + '\n');
  run(home, ['--force']);
  const after = readUsage(home);
  const months = new Set(after.filter((r) => r.rollup).map((r) => r.rollup));
  check('разные месяцы не слиты', months.size, 2);
  fs.rmSync(home, { recursive: true, force: true });
}

// --- 4. dry-run ничего не меняет
{
  const home = sandbox();
  fs.writeFileSync(usagePath(home), JSON.stringify(session('a', 300, 9.99)) + '\n');
  const stale = path.join(home, '.claude', 'telemetry', 'old.json');
  aged(stale, 30);
  const before = fs.readFileSync(usagePath(home), 'utf8');
  run(home, ['--dry-run']);
  check('dry-run: журнал не тронут', fs.readFileSync(usagePath(home), 'utf8'), before);
  check('dry-run: файл на месте', fs.existsSync(stale), true);
  fs.rmSync(home, { recursive: true, force: true });
}

// --- 5. Удаление по возрасту, а не подряд
{
  const home = sandbox();
  const dir = path.join(home, '.claude', 'telemetry');
  aged(path.join(dir, 'old.json'), 30);
  aged(path.join(dir, 'fresh.json'), 1);
  run(home, ['--force']);
  check('старый удалён', fs.existsSync(path.join(dir, 'old.json')), false);
  check('свежий сохранён', fs.existsSync(path.join(dir, 'fresh.json')), true);
  fs.rmSync(home, { recursive: true, force: true });
}

// --- 6. Дроссель: второй запуск подряд не работает
{
  const home = sandbox();
  const dir = path.join(home, '.claude', 'telemetry');
  aged(path.join(dir, 'a.json'), 30);
  run(home, ['--force']);
  aged(path.join(dir, 'b.json'), 30);
  run(home);
  check('дроссель держит сутки', fs.existsSync(path.join(dir, 'b.json')), true);
  fs.rmSync(home, { recursive: true, force: true });
}

// --- 7. Битые строки не роняют свёртку
{
  const home = sandbox();
  fs.writeFileSync(usagePath(home),
    'не json\n' + JSON.stringify(session('a', 200, 3)) + '\n{"обрезано":\n' + JSON.stringify(session('b', 1, 1)) + '\n');
  let crashed = false;
  try { run(home, ['--force']); } catch { crashed = true; }
  check('битые строки не роняют', crashed, false);
  const after = readUsage(home);
  check('деньги из читаемых строк уцелели', totalCost(after), 4);
  fs.rmSync(home, { recursive: true, force: true });
}

// --- 8. Пустой и отсутствующий журнал
{
  const home = sandbox();
  let crashed = false;
  try { run(home, ['--force']); } catch { crashed = true; }
  check('нет журнала — не падает', crashed, false);
  fs.writeFileSync(usagePath(home), '');
  try { run(home, ['--force']); } catch { crashed = true; }
  check('пустой журнал — не падает', crashed, false);
  fs.rmSync(home, { recursive: true, force: true });
}

// --- 9. Каталоги вне списка не трогаются
{
  const home = sandbox();
  const keep = path.join(home, '.claude', 'projects');
  fs.mkdirSync(keep, { recursive: true });
  aged(path.join(keep, 'transcript.jsonl'), 400);
  run(home, ['--force']);
  check('транскрипты не удаляются', fs.existsSync(path.join(keep, 'transcript.jsonl')), true);
  fs.rmSync(home, { recursive: true, force: true });
}

// --- 10. Планы задач: брошенный уходит через две недели, живой остаётся
{
  const home = sandbox();
  const dir = path.join(home, '.claude', 'plans');
  fs.mkdirSync(dir, { recursive: true });
  aged(path.join(dir, 'abandoned.md'), 15);
  aged(path.join(dir, 'active.md'), 13);
  run(home, ['--force']);
  check('план без правок 15 дней удалён', fs.existsSync(path.join(dir, 'abandoned.md')), false);
  check('план с правкой 13 дней назад сохранён', fs.existsSync(path.join(dir, 'active.md')), true);
  fs.rmSync(home, { recursive: true, force: true });
}

// --- 11. Ask mode: метка сессии уходит, режим по умолчанию остаётся навсегда
{
  const home = sandbox();
  const dir = path.join(home, '.claude', 'state', 'ask-mode');
  fs.mkdirSync(dir, { recursive: true });
  aged(path.join(dir, 'sess-old'), 46, 'on');
  aged(path.join(dir, 'sess-live'), 1, 'on');
  aged(path.join(dir, 'default'), 400, 'on');
  run(home, ['--force']);
  check('метка сессии старше 45 дней удалена', fs.existsSync(path.join(dir, 'sess-old')), false);
  check('метка живой сессии сохранена', fs.existsSync(path.join(dir, 'sess-live')), true);
  check('default не удаляется по возрасту', fs.existsSync(path.join(dir, 'default')), true);
  fs.rmSync(home, { recursive: true, force: true });
}

process.stdout.write(failed ? `\n=== ${failed} FAIL ===\n` : '\n=== все проверки прошли ===\n');
process.exit(failed ? 1 : 0);
