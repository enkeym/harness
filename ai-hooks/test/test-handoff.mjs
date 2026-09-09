#!/usr/bin/env node
// Тест передачи между сессиями. Она существует ради того, чтобы `/clear` не
// означал потерю: контекст выбрасывается, состояние работы возвращается. Отсюда
// и проверки — ключ по корню репозитория, протухшее не подставляется, длинное
// не превращается в новую статью расхода.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const HOOK = path.join(ROOT, 'claude', 'handoff-load.mjs');

let failed = 0;
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  process.stdout.write(`${ok ? 'ok  ' : 'FAIL'} ${name} (got=${JSON.stringify(got)}, want=${JSON.stringify(want)})\n`);
  if (!ok) failed++;
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'handoff-'));
const home = path.join(tmp, 'home');
const repo = path.join(home, 'proj');
const nested = path.join(repo, 'src', 'modules');
fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
fs.mkdirSync(nested, { recursive: true });

// Ядро импортируем в подменённом HOME: путь передачи считается от него.
process.env.HOME = home;
const { handoffPath, handoffContext, readHandoff } = await import('../handoff-core.mjs');

function runHook(cwd) {
  const out = execFileSync('node', [HOOK], {
    input: JSON.stringify({ cwd, source: 'startup', hook_event_name: 'SessionStart' }),
    encoding: 'utf8',
    env: { ...process.env, HOME: home },
  });
  return out.trim() ? JSON.parse(out).hookSpecificOutput.additionalContext : null;
}

// --- ключ — корень репозитория, а не буквальный каталог
check('подкаталог даёт тот же файл', handoffPath(nested), handoffPath(repo));
check('файл лежит в ~/.claude/handoff', handoffPath(repo).startsWith(path.join(home, '.claude', 'handoff')), true);
check('имя читаемое', path.basename(handoffPath(repo)).startsWith('proj-'), true);

// --- разные проекты не делят передачу
{
  const other = path.join(home, 'other');
  fs.mkdirSync(path.join(other, '.git'), { recursive: true });
  check('разные проекты — разные файлы', handoffPath(other) === handoffPath(repo), false);
}

// --- одноимённые каталоги в разных местах: состояние приватного проекта не
// должно подставиться в сессию рабочего
{
  const a = path.join(home, 'main', 'vpn-new');
  const b = path.join(home, 'work', 'vpn-new');
  check('одноимённые проекты — разные файлы', handoffPath(a) === handoffPath(b), false);
  check('пути одной длины — тоже разные', a.length === b.length && handoffPath(a) !== handoffPath(b), true);
  check('имя всё ещё читаемое', path.basename(handoffPath(a)).startsWith('vpn-new-'), true);
}

// --- нет файла: молчим
check('нет передачи: null', readHandoff(repo), null);
check('нет передачи: хук молчит', runHook(repo), null);

// --- есть файл: подставляется
const file = handoffPath(repo);
fs.mkdirSync(path.dirname(file), { recursive: true });
fs.writeFileSync(file, '## Состояние\n\nВетка feat/x, тесты зелёные. Дальше: ревью.\n');

{
  const ctx = handoffContext(repo);
  check('текст передачи на месте', /Ветка feat\/x, тесты зелёные/.test(ctx), true);
  check('назван возраст', /мин назад|ч назад|дн назад/.test(ctx), true);
  check('назван путь файла', ctx.includes(file), true);
  check('помечено как снимок, а не инструкция', /проверяй факты/.test(ctx), true);
  check('хук отдаёт то же', /Ветка feat\/x/.test(runHook(nested)), true);
}

// --- пустой файл передачей не считается
{
  fs.writeFileSync(file, '   \n\n');
  check('пустая передача: null', readHandoff(repo), null);
  fs.writeFileSync(file, '## Состояние\n\nВетка feat/x, тесты зелёные.\n');
}

// --- протухшее не подставляем: оно описывает работу, которой уже нет
{
  const old = Date.now() - 20 * 24 * 3600 * 1000;
  fs.utimesSync(file, old / 1000, old / 1000);
  check('старая передача: помечена stale', readHandoff(repo).stale, true);
  check('старая передача: в контекст не идёт', handoffContext(repo), null);
  check('старая передача: хук молчит', runHook(repo), null);
  fs.utimesSync(file, Date.now() / 1000, Date.now() / 1000);
}

// --- длинная обрезается: указатель на состояние, а не пересказ сессии
{
  fs.writeFileSync(file, 'x'.repeat(20_000));
  const h = readHandoff(repo);
  check('длина ограничена', h.text.length < 6_500, true);
  check('сказано, что обрезано', /передача обрезана/.test(h.text), true);
}

// --- битый ввод не роняет старт сессии
{
  const out = execFileSync('node', [HOOK], { input: 'не json', encoding: 'utf8', env: { ...process.env, HOME: home } });
  check('битый ввод: пустой ответ', out.trim(), '');
}

fs.rmSync(tmp, { recursive: true, force: true });
process.stdout.write(failed ? `\n=== ${failed} FAIL ===\n` : '\n=== все проверки прошли ===\n');
process.exit(failed ? 1 : 0);
