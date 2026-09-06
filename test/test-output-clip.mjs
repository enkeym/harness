#!/usr/bin/env node
// Тест ограничителя вывода. Две вещи, ради которых он вообще проверяется:
// он не должен менять смысл команды (иначе экономия куплена ценой ошибок) и
// обязан сохранять код возврата — упавшие тесты, выданные за зелёные, дороже
// любого сэкономленного токена.

import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { clipCommand } from '../claude/output-clip.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const CLIP = path.join(ROOT, 'bin', 'clip-output.sh');
const HOOK = path.join(ROOT, 'claude', 'output-clip.mjs');

let failed = 0;
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  process.stdout.write(`${ok ? 'ok  ' : 'FAIL'} ${name} (got=${JSON.stringify(got)}, want=${JSON.stringify(want)})\n`);
  if (!ok) failed++;
}

const wrapped = (cmd, opts) => clipCommand(cmd, opts) !== null;

// --- шумное оборачивается
for (const cmd of ['npm test', 'npm ci', 'npm run build', 'npx tsc --noEmit', 'pnpm install',
  'docker build .', 'cargo test', 'pytest', 'go test ./...', 'make', 'find . -name "*.ts"',
  'git log --oneline', 'git diff', 'eslint .', 'CI=1 npm test']) {
  check(`оборачивает: ${cmd}`, wrapped(cmd), true);
}

// --- тихое не трогаем
for (const cmd of ['ls -la', 'git status --short', 'echo hi', 'node -v', 'git push',
  'npm view react version', 'git commit -m x', 'mkdir -p out']) {
  check(`не трогает: ${cmd}`, wrapped(cmd), false);
}

// --- команда со своим конвейером или редиректом уже ограничена автором
for (const cmd of ['npm test | tail -5', 'npm test > out.txt', 'npm test 2> err.log',
  'npm test; ls', 'npm test &', 'echo $(npm test)', 'npm test `date`']) {
  check(`не трогает составное: ${cmd}`, wrapped(cmd), false);
}

// --- следящие команды: обрезать нечего, они не заканчиваются
for (const cmd of ['vitest --watch', 'docker logs -f api', 'jest --watchAll', 'npm test -- --watch']) {
  check(`не трогает следящее: ${cmd}`, wrapped(cmd), false);
}

// --- цепочка через && : только переходы по каталогам
check('оборачивает cd + шумное', wrapped('cd client && npm test'), true);
check('не оборачивает чужую цепочку', wrapped('rm -rf dist && npm test'), false);

// --- фоновая команда читается отдельным вызовом, ограничитель ей помешает
check('не трогает фоновое', wrapped('npm test', { background: true }), false);

// --- двойного оборачивания не бывает
check('не оборачивает дважды', wrapped(clipCommand('npm test')), false);

// --- пустое и мусор
check('пустая команда', clipCommand(''), null);
check('undefined', clipCommand(undefined), null);

// --- кавычки внутри команды переживают обёртку
{
  const cmd = `npm test -- -t 'имя с пробелом'`;
  const out = execFileSync('bash', ['-c', `${clipCommand(cmd).replace(CLIP, 'echo')}`], { encoding: 'utf8' });
  check('кавычки не рвут команду', out.trim(), cmd);
}

// --- хук отдаёт updatedInput в формате Claude Code
{
  const out = execFileSync('node', [HOOK], {
    input: JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'npm test' } }),
    encoding: 'utf8',
  });
  const parsed = JSON.parse(out);
  check('hookEventName', parsed.hookSpecificOutput.hookEventName, 'PreToolUse');
  check('updatedInput.command обёрнут', /clip-output\.sh/.test(parsed.hookSpecificOutput.updatedInput.command), true);

  const quiet = execFileSync('node', [HOOK], {
    input: JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'ls' } }),
    encoding: 'utf8',
  });
  check('тихая команда: хук молчит', quiet.trim(), '');
}

// --- поведение самого ограничителя
const store = fs.mkdtempSync(path.join(os.tmpdir(), 'clip-'));
const runClip = (cmd, env = {}) => spawnSync('bash', [CLIP, cmd], {
  encoding: 'utf8',
  env: { ...process.env, CLIP_DIR: store, ...env },
});

{
  const r = runClip('echo одна строка');
  check('короткий вывод: печатается целиком', r.stdout.trim(), 'одна строка');
  check('короткий вывод: файл не остаётся', fs.readdirSync(store).length, 0);
}

{
  // Главное свойство: код возврата — команды, а не конвейера.
  check('код возврата сохраняется', runClip('exit 3').status, 3);
  check('успех остаётся успехом', runClip('true').status, 0);
  const failing = runClip('seq 1 500; exit 7');
  check('падение длинной команды видно', failing.status, 7);
}

{
  const r = runClip('seq 1 500', { CLIP_HEAD: '5', CLIP_TAIL: '5' });
  const lines = r.stdout.trim().split('\n');
  check('длинный вывод обрезан', lines.length < 20, true);
  check('начало на месте', lines[0], '1');
  check('конец на месте', lines[lines.length - 1], '500');
  check('сказано, сколько пропущено', /пропущено 490 строк из 500/.test(r.stdout), true);
  check('полный вывод сохранён в файл', fs.readdirSync(store).some((f) => f.endsWith('.log')), true);
  const saved = fs.readdirSync(store).find((f) => f.endsWith('.log'));
  check('в файле весь вывод', fs.readFileSync(path.join(store, saved), 'utf8').trim().split('\n').length, 500);
}

{
  // stderr тоже вывод: диагностика падения не должна теряться.
  const r = runClip('echo в поток ошибок >&2');
  check('stderr попадает в вывод', /в поток ошибок/.test(r.stdout), true);
}

{
  const r = spawnSync('bash', [CLIP], { encoding: 'utf8' });
  check('без аргументов: понятная ошибка', r.status, 2);
}

fs.rmSync(store, { recursive: true, force: true });
process.stdout.write(failed ? `\n=== ${failed} FAIL ===\n` : '\n=== все проверки прошли ===\n');
process.exit(failed ? 1 : 0);
