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

const HOME = process.env.HOME || os.homedir();
const CLIP = path.join(HOME, '.ai-hooks', 'bin', 'clip-output.sh');

// Команда шумная, если длинный вывод для неё штатен. Ключ — имя команды,
// значение — набор подкоманд (пустой набор означает «любая»).
const NOISY = new Map([
  ['npm', new Set(['install', 'i', 'ci', 'test', 'run', 'audit', 'outdated', 'update', 'ls', 'publish'])],
  ['pnpm', new Set(['install', 'i', 'test', 'run', 'audit', 'outdated', 'update', 'ls', 'add'])],
  ['yarn', new Set(['install', 'test', 'run', 'audit', 'outdated', 'upgrade', 'list', 'add'])],
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
  ['git', new Set(['log', 'diff', 'show', 'blame'])],
]);

// Флаги, после которых команда не завершается сама (или её вывод и нужен
// целиком в реальном времени). Обрезать такое — значит спрятать происходящее.
const STREAMING = /(^|\s)(-f|-w|--follow|--watch|--watchAll|--tail)(\s|=|$)/;

// Всё, что делает команду составной: свой конвейер, редирект, подстановка,
// фон, последовательность. Единственное исключение — `&&`, разобранное ниже.
const COMPLEX = /[|<>;`]|\$\(|(^|[^&])&($|[^&])/;

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
  if (COMPLEX.test(cmd)) return null;

  // `cd client && npm test` — частый и безопасный случай: цепочка из переходов
  // по каталогам, заканчивающаяся шумной командой.
  const parts = cmd.split('&&').map((p) => p.trim()).filter(Boolean);
  if (parts.length === 0) return null;
  const last = parts[parts.length - 1];
  const leadingAreCd = parts.slice(0, -1).every((p) => /^cd\s/.test(p));
  if (!leadingAreCd || !isNoisy(last)) return null;

  return `${CLIP} ${shellQuote(cmd)}`;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
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
