#!/usr/bin/env node
// Тесты фонового доктора. `claude` подменяется fixtures/fake-claude.mjs, так
// что проверяется всё вокруг него: выключатели, дебаунс по проекту и
// симптому, отвязанный раннер и состояние после него, чистое окружение
// ребёнка, и напоминание, которое возвращает итог в сессию один раз.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const FAKE = path.join(ROOT, 'test', 'fixtures', 'fake-claude.mjs');
const REMINDER = path.join(ROOT, 'claude', 'doctor-reminder.mjs');
const APPLIED = path.join(ROOT, 'bin', 'doctor-applied.mjs');

// Состояние — во временный каталог ДО импорта: state-core читает переменную
// при загрузке. Проект — временный git-репозиторий, чтобы ключ и ветка были
// настоящими.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-test-'));
const stateDir = path.join(tmp, 'state');
const project = path.join(tmp, 'project');
fs.mkdirSync(path.join(project, '.git'), { recursive: true });
fs.writeFileSync(path.join(project, '.git', 'HEAD'), 'ref: refs/heads/feature/x\n');
process.env.AI_HOOKS_STATE_DIR = stateDir;
process.env.AI_HOOKS_HOOKS_LOG = path.join(tmp, 'hooks.jsonl');
process.env.AI_HOOKS_DOCTOR_CMD = FAKE;
process.env.FAKE_CLAUDE_TRACE = path.join(tmp, 'trace.json');
delete process.env.AI_HOOKS_DOCTOR_OFF;
delete process.env.AI_HOOKS_DOCTOR;
process.env.CLAUDECODE = '1'; // как внутри настоящей сессии
fs.chmodSync(FAKE, 0o755);

const { maybeSpawnDoctor, readState, stateFile, CHILD_MARK, buildPrompt, recordSaid } = await import('../doctor-core.mjs');
const { readJSON, writeJSON } = await import('../state-core.mjs');

let failed = 0;
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  process.stdout.write(`${ok ? 'ok  ' : 'FAIL'} ${name} (got=${JSON.stringify(got)}, want=${JSON.stringify(want)})\n`);
  if (!ok) failed++;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitDone(root, ms = 8000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    const st = readState(root);
    if (st.status === 'done' || st.status === 'failed') return st;
    await sleep(100);
  }
  return readState(root);
}

function reminder(sid, cwd = project) {
  const res = spawnSync('node', [REMINDER], {
    input: JSON.stringify({ session_id: sid, cwd, prompt: 'x' }),
    encoding: 'utf8',
    env: process.env,
  });
  if (!res.stdout.trim()) return '';
  return JSON.parse(res.stdout).hookSpecificOutput.additionalContext;
}

const call = (symptom = 'breaker-open', sid = 'sid-main') =>
  maybeSpawnDoctor({ root: project, symptom, detail: { tool: 'Read', target: 'a.ts' }, sid });

// --- запись состояния атомарна ---
{
  const dir = path.join(tmp, 'atomic');
  const file = path.join(dir, 's.json');
  check('writeJSON: записал', [writeJSON(file, { a: 1 }), readJSON(file, null)], [true, { a: 1 }]);
  writeJSON(file, { a: 2 });
  check('writeJSON: перезапись без временных файлов рядом', [readJSON(file, null), fs.readdirSync(dir)], [{ a: 2 }, ['s.json']]);
  const blocked = path.join(file, 'nested.json'); // родитель — файл, запись невозможна
  check('writeJSON: сбой → false, мусора нет, прежнее цело', [writeJSON(blocked, {}), fs.readdirSync(dir), readJSON(file, null)], [false, ['s.json'], { a: 2 }]);
}

// --- выключатели ---
{
  process.env.AI_HOOKS_DOCTOR_OFF = '1';
  check('AI_HOOKS_DOCTOR_OFF=1 → не запускается', call(), false);
  delete process.env.AI_HOOKS_DOCTOR_OFF;

  process.env[CHILD_MARK] = '1';
  check('внутри доктора (метка ребёнка) → не запускается', call(), false);
  delete process.env[CHILD_MARK];

  fs.mkdirSync(path.join(stateDir, 'doctor'), { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'doctor', 'off'), '');
  check('файл state/doctor/off → не запускается', call(), false);
  fs.unlinkSync(path.join(stateDir, 'doctor', 'off'));

  check('без корня → не запускается', maybeSpawnDoctor({ root: null, symptom: 'breaker-open' }), false);
  check('состояние не создано впустую', fs.existsSync(stateFile(project)), false);
}

// --- промпт ---
{
  const p = buildPrompt({ root: project, symptom: 'server-mismatch', detail: { a: 1 }, sid: 'sid-p' });
  check('промпт: ссылка на скилл и запрет правок', p.includes('skills/doctor/SKILL.md') && p.includes('Ничего не правь'), true);
  check('промпт: ветка, сессия, событие', p.includes('feature/x') && p.includes('sid-p') && p.includes('{"a":1}'), true);
  check('промпт: формат ответа', p.includes('Причина: <'), true);
}

// --- запуск, раннер, состояние ---
{
  // Подмена отвечает мгновенно; задержка нужна, чтобы застать состояние running.
  process.env.FAKE_CLAUDE_SLEEP_MS = '1500';
  check('первый симптом → запуск', call(), true);
  delete process.env.FAKE_CLAUDE_SLEEP_MS;
  const queued = readState(project);
  check('состояние сразу помечено', [queued.status, queued.symptom, queued.sid, typeof queued.last['breaker-open']], ['queued', 'breaker-open', 'sid-main', 'number']);
  check('пока идёт → второй запуск не стартует', call(), false);
  check('пока идёт → напоминание говорит «идёт разбор»', reminder('sid-main').includes('идёт фоновый разбор'), true);
  check('… и второй раз той же сессии молчит', reminder('sid-main'), '');

  const st = await waitDone(project);
  check('раннер завершился: done, exit 0', [st.status, st.exit], ['done', 0]);
  check('заголовок — строка «Причина»', st.headline, 'Причина: тестовая причина из подмены claude');
  check('отчёт записан из stdout', fs.readFileSync(st.report, 'utf8').includes('Предложение: ничего'), true);
  check('промпт лежал рядом с отчётом', fs.existsSync(st.report.replace(/\.md$/, '.prompt.md')), true);

  const trace = readJSON(process.env.FAKE_CLAUDE_TRACE, {});
  check('ребёнок: cwd = корень проекта', trace.cwd, project);
  check('ребёнок: метка есть, CLAUDE* вычищены', [...(trace.envKeys || [])].sort(), ['AI_HOOKS_DOCTOR', 'AI_HOOKS_DOCTOR_CMD']);
  const argv = trace.argv || [];
  check('ребёнок: -p и промпт первыми', [argv[0], String(argv[1]).startsWith('Ты фоновый /doctor')], ['-p', true]);
  check('ребёнок: бюджет, dontAsk, без правок', argv.includes('--max-budget-usd') && argv.includes('dontAsk') && argv.includes('Edit') && argv.includes('--allowedTools'), true);
  check('ребёнок: allowedTools последними (variadic не глотает промпт)', argv.indexOf('--allowedTools') > argv.indexOf('--disallowedTools'), true);
}

// --- дебаунс и напоминание об итоге ---
{
  check('тот же симптом после done → дебаунс', call(), false);
  const said = reminder('sid-main');
  check('итог приходит в сессию одной строкой doctor(...)', said.startsWith('doctor (') && said.includes('Причина: тестовая причина') && said.includes('/doctor apply'), true);
  check('повторно той же сессии — молчит', reminder('sid-main'), '');
  check('breaker-open другой сессии — молчит (отпечаток сессионный)', reminder('sid-other'), '');
  check('вне проекта — молчит', reminder('sid-main', os.tmpdir()), '');

  check('другой симптом → новый запуск', call('server-mismatch', 'sid-2'), true);
  const st = await waitDone(project);
  check('второй запуск завершён', st.status, 'done');
  check('дебаунс хранится по каждому симптому', Object.keys(st.last).sort(), ['breaker-open', 'server-mismatch']);
}

// --- отпечаток события: та же проблема не разбирается дважды ---
{
  const file = stateFile(project);
  // Снимаем только временной дебаунс — проверяем отпечаток, а не время.
  const resetDebounce = () => fs.writeFileSync(file, JSON.stringify({ ...readJSON(file, {}), last: {} }));
  const breaker = (family, sid) =>
    maybeSpawnDoctor({ root: project, symptom: 'breaker-open', detail: { tool: 'Edit', target: 'b.ts', family }, sid });

  resetDebounce();
  check('дебаунс снят, отпечаток прежний, отчёт не применён → не запускается', call(), false);
  check('та же сессия, другой класс → новый отпечаток → запуск', breaker('edit', 'sid-main'), true);
  await waitDone(project);
  resetDebounce();
  check('другая сессия, тот же класс → запуск', breaker('edit', 'sid-new'), true);
  await waitDone(project);
  resetDebounce();
  check('повтор отпечатка после done → не запускается', breaker('edit', 'sid-new'), false);
  check('состояние: отпечаток и applied=false', [readState(project).fp['breaker-open'], readState(project).applied['breaker-open']], ['sid-new|edit', false]);

  const out = execFileSync('node', [APPLIED, project], { encoding: 'utf8', env: process.env });
  check('doctor-applied: называет симптом', out.includes('breaker-open'), true);
  check('состояние: applied=true', readState(project).applied['breaker-open'], true);
  check('применённый отчёт reminder не объявляет', reminder('sid-applied'), '');
  check('после применения тот же отпечаток → запуск', breaker('edit', 'sid-new'), true);
  await waitDone(project);

  const mismatch = (branch) => maybeSpawnDoctor({
    root: project, symptom: 'server-mismatch',
    detail: { root: project, branch, guard_db: '.tokensave/x.db', servers: [] }, sid: 'sid-mm',
  });
  resetDebounce();
  check('mismatch: корень+ветка+БД → запуск', mismatch('feature/x'), true);
  await waitDone(project);
  resetDebounce();
  check('mismatch: то же состояние — хоть через час → не запускается', mismatch('feature/x'), false);
  check('mismatch: другая ветка → новый отпечаток → запуск', mismatch('gov2-room'), true);
  await waitDone(project);
}

// --- сбой headless-сессии ---
{
  process.env.FAKE_CLAUDE_EXIT = '3';
  // Снимаем дебаунс руками: проверяем не его, а ветку failed.
  const file = stateFile(project);
  fs.writeFileSync(file, JSON.stringify({ ...readJSON(file, {}), last: {} }));
  check('после сброса дебаунса → запуск', call(), true);
  const st = await waitDone(project);
  check('claude упал → failed с кодом', [st.status, st.exit, st.headline], ['failed', 3, null]);
  // sid-main уже слышал прошлый отчёт — новый запуск сбрасывает «сказали».
  const said = reminder('sid-main');
  check('напоминание о сбое ведёт в .log — и сессии, слышавшей прошлый отчёт', said.includes('не завершился (exit 3)') && said.includes('.log'), true);
  delete process.env.FAKE_CLAUDE_EXIT;
}

// --- строка про затянувшийся server-mismatch ---
{
  const rec = { ts: new Date().toISOString(), sid: 'sid-mm', hook: 'read-search-router', tool: 'Read', decision: 'server-mismatch', ms: 12, root: project, branch: 'feature/x', servers: 0 };
  fs.writeFileSync(process.env.AI_HOOKS_HOOKS_LOG, JSON.stringify(rec) + '\n' + JSON.stringify(rec) + '\n');
  const said = reminder('sid-mm');
  check('mismatch: одна строка с корнем, веткой и счётчиком', said.includes(`${project}@feature/x`) && said.includes('(2 событий'), true);
  check('mismatch: второй раз молчит', reminder('sid-mm'), '');
  const old = { ...rec, ts: new Date(Date.now() - 3600 * 1000).toISOString() };
  fs.writeFileSync(process.env.AI_HOOKS_HOOKS_LOG, JSON.stringify(old) + '\n');
  check('mismatch: событие старше окна не упоминается', reminder('sid-mm-old').includes('tokensave-гард молчит'), false);
}

// --- отчёт по server-mismatch объявляется, только пока рассинхрон жив ---
{
  const file = stateFile(project);
  const report = path.join(tmp, 'mm-report.md');
  fs.writeFileSync(report, 'Причина: сервер на другой ветке\n');
  fs.writeFileSync(file, JSON.stringify({
    ...readJSON(file, {}), status: 'done', symptom: 'server-mismatch', sid: 'sid-mm',
    finished: Date.now(), report, headline: 'Причина: сервер на другой ветке',
    fp: { 'server-mismatch': `${project}|feature/x|.tokensave/x.db` },
    applied: {}, announced: [],
  }));
  fs.writeFileSync(process.env.AI_HOOKS_HOOKS_LOG, '');
  check('mismatch-отчёт: рассинхрона в журнале нет → молчит', reminder('sid-fixed'), '');
  const rec = { ts: new Date().toISOString(), sid: 'sid-live', decision: 'server-mismatch', root: project, branch: 'feature/x' };
  fs.writeFileSync(process.env.AI_HOOKS_HOOKS_LOG, JSON.stringify({ ...rec, branch: 'other' }) + '\n');
  check('mismatch-отчёт: рассинхрон на другой ветке → отчёт молчит', reminder('sid-other-branch').startsWith('doctor ('), false);
  fs.writeFileSync(process.env.AI_HOOKS_HOOKS_LOG, JSON.stringify(rec) + '\n');
  const said = reminder('sid-live');
  check('mismatch-отчёт: свежий рассинхрон → объявляет без дубля строки гарда', said.startsWith('doctor (') && !said.includes('tokensave-гард молчит'), true);
}

// --- зависший запуск не объявляется «идёт разбор» ---
{
  const file = stateFile(project);
  fs.writeFileSync(process.env.AI_HOOKS_HOOKS_LOG, '');
  fs.writeFileSync(file, JSON.stringify({
    ...readJSON(file, {}), status: 'running', symptom: 'breaker-open', sid: 'sid-stale',
    started: Date.now() - 16 * 60 * 1000, finished: null, runningSaid: [],
  }));
  check('running старше 15 минут → молчит', reminder('sid-stale'), '');
  fs.writeFileSync(file, JSON.stringify({ ...readJSON(file, {}), started: Date.now() }));
  check('свежий running → говорит', reminder('sid-stale').includes('идёт фоновый разбор'), true);
}

// --- отметки «сказали» ложатся на свежее состояние ---
{
  const file = stateFile(project);
  const base = { status: 'running', symptom: 'breaker-open', sid: 's', started: 100, announced: [], runningSaid: [] };
  // Напоминание прочитало running (started 100), а раннер успел записать done.
  fs.writeFileSync(file, JSON.stringify({ ...base, status: 'done', finished: 200, headline: 'Причина: x' }));
  recordSaid(project, ['runningSaid'], 's', 100);
  const st = readState(project);
  check('recordSaid: done раннера не затёрт, отметка легла', [st.status, st.headline, st.runningSaid], ['done', 'Причина: x', ['s']]);
  // Между чтением и записью стартовал новый запуск.
  fs.writeFileSync(file, JSON.stringify({ ...base, started: 300 }));
  recordSaid(project, ['announced', 'mismatchSaid'], 's', 100);
  const next = readState(project);
  check('recordSaid: новый запуск не помечен сказанным, mismatchSaid — да', [next.announced, next.mismatchSaid, next.root], [[], ['s'], project]);
}

process.stdout.write(failed ? `\n=== ${failed} проверок упало ===\n` : '\n=== все проверки прошли ===\n');
process.exit(failed ? 1 : 0);
