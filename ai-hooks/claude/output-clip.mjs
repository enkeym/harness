#!/usr/bin/env node
// Claude Code, PreToolUse (Bash): шумные команды выполняются через ограничитель
// вывода.
//
// Замер за неделю: 66.6 МТокенов чтения кеша на ~540 вызовов инструментов,
// то есть каждый вызов перечитывал весь накопленный контекст. Значит цену
// сессии задаёт произведение «размер контекста × число шагов», и простыня от
// `npm ci` дорога не в момент печати, а на всех последующих ходах.
//
// Оборачиваем только то, где длинный вывод — норма, и только когда команда
// простая: свои конвейеры, редиректы, подстановки и фоновый запуск не трогаем,
// иначе хук начнёт менять семантику команды вместо её объёма. Ограничитель
// сохраняет код возврата (см. bin/clip-output.sh), поэтому упавшая сборка
// остаётся упавшей.

import path from 'node:path';
import os from 'node:os';
import { isEntryPoint } from '../state-core.mjs';

const HOME = process.env.HOME || os.homedir();
const CLIP = path.join(HOME, '.ai-hooks', 'bin', 'clip-output.sh');

// Команда шумная, если длинный вывод для неё штатен. Ключ — имя команды,
// значение — набор подкоманд (пустой набор означает «любая»).
//
// Чего здесь намеренно нет:
//
// `git log|diff|show` и `npm audit` — команды верификации. Их середина и есть
// содержание: обрезанный `git diff main...HEAD` показал бы начало и конец, а
// правка посреди ветки уехала бы в push непросмотренной. Экономить на том, чем
// проверяешь, нельзя.
//
// `npm publish` и прочее, что спрашивает OTP или пароль: вывод уходит в файл,
// приглашение не видно, команда виснет.
const NOISY = new Map([
  ['npm', new Set(['install', 'i', 'ci', 'test', 'run', 'outdated', 'update', 'ls'])],
  ['pnpm', new Set(['install', 'i', 'test', 'run', 'outdated', 'update', 'ls', 'add'])],
  ['yarn', new Set(['install', 'test', 'run', 'outdated', 'upgrade', 'list', 'add'])],
  ['bun', new Set(['install', 'test', 'run', 'add'])],
  ['npx', new Set()],
  ['tsc', new Set()],
  ['jest', new Set()],
  ['vitest', new Set()],
  ['eslint', new Set()],
  ['prettier', new Set()],
  ['biome', new Set()],
  ['docker', new Set(['build', 'compose', 'pull', 'images', 'ps'])],
  ['docker-compose', new Set(['build', 'up', 'pull'])],
  ['cargo', new Set(['build', 'test', 'check', 'clippy'])],
  ['pytest', new Set()],
  ['go', new Set(['test', 'build', 'vet'])],
  ['make', new Set()],
  ['gradle', new Set()],
  ['mvn', new Set()],
  ['find', new Set()],
]);

// Флаги, после которых команда не завершается сама (или её вывод и нужен
// целиком в реальном времени). Обрезать такое — значит спрятать происходящее.
const STREAMING = /(^|\s)(-f|-w|--follow|--watch|--watchAll|--tail)(\s|=|$)/;

// Команда может попросить ввод: пароль, OTP, ответ генератора. Вывод уходит в
// файл, приглашения не видно, и вместо экономии получаем повисший вызов. Для
// `sudo` это ещё и приглашение ввести пароль вслепую.
const INTERACTIVE = /(^|\s)(sudo|su)(\s|$)|(^|\s)(login|logout|adduser|init|prune)(\s|$)|(^|\s)(-i|--interactive)(\s|=|$)|create-/;

// Всё, что делает команду составной: свой конвейер, редирект, подстановка,
// фон, последовательность, вторая строка. Классификатор смотрит на первую
// команду, поэтому составное не оборачиваем вовсе — иначе решение по `npm test`
// распространилось бы на приписанное следом.
//
// `&&` тоже здесь. Обёртка выполняет команду в дочернем `bash -c`, а `cd`
// внутри него не переживает вызов: `cd client && npm ci` оставил бы cwd сессии
// прежним, и следующая команда ушла бы не в тот каталог. Менять семантику ради
// объёма — не тот размен.
const COMPLEX = /[|<>;`&\n\r]|\$\(/;

function commandOf(segment) {
  // Ведущие присваивания окружения (`CI=1 npm test`) командой не являются.
  const tokens = segment.trim().split(/\s+/).filter(Boolean);
  let i = 0;
  while (i < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i])) i++;
  if (i >= tokens.length) return null;
  const name = path.basename(tokens[i]);
  const sub = tokens.slice(i + 1).find((t) => !t.startsWith('-')) || '';
  return { name, sub };
}

function isNoisy(segment) {
  const cmd = commandOf(segment);
  if (!cmd) return false;
  const subs = NOISY.get(cmd.name);
  if (!subs) return false;
  return subs.size === 0 || subs.has(cmd.sub);
}

// Одинарные кавычки: внутри них шелл не интерпретирует ничего, кроме самой
// кавычки — её и экранируем разрывом строки.
function shellQuote(s) {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

export function clipCommand(command, opts = {}) {
  const cmd = String(command || '').trim();
  if (!cmd) return null;
  if (opts.background) return null;
  if (cmd.includes('clip-output.sh')) return null;
  if (STREAMING.test(cmd)) return null;
  if (INTERACTIVE.test(cmd)) return null;
  if (COMPLEX.test(cmd)) return null;
  if (!isNoisy(cmd)) return null;

  // Перед `--` идёт метка из имени команды и подкоманды, после `--` —
  // единственное, что исполняется. Без метки все обёрнутые команды выглядели бы
  // одинаково, и разрешение «больше не спрашивать» для `npm test` молча
  // распространилось бы на `npm run deploy` и `make`: правило разрешений
  // строится по префиксу строки.
  // Только имя и подкоманда: флаг `--` в метке съел бы разделитель, а
  // присваивания окружения метку не описывают.
  const label = cmd.split(/\s+/).slice(0, 2)
    .filter((t) => /^[\w.@/-]+$/.test(t) && !t.startsWith('-'))
    .join(' ');
  return `${CLIP} ${label} -- ${shellQuote(cmd)}`;
}

if (isEntryPoint(import.meta.url)) {
  let raw = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (c) => { raw += c; });
  process.stdin.on('end', () => {
    try {
      const input = JSON.parse(raw);
      const ti = input.tool_input || {};
      if (input.tool_name === 'Bash') {
        const clipped = clipCommand(ti.command, { background: ti.run_in_background });
        if (clipped) {
          process.stdout.write(JSON.stringify({
            hookSpecificOutput: {
              hookEventName: 'PreToolUse',
              updatedInput: { ...ti, command: clipped },
            },
          }));
        }
      }
    } catch { /* ограничитель вывода не должен мешать команде выполниться */ }
    process.exit(0);
  });
}
