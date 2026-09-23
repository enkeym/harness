#!/usr/bin/env node
// Тест ask mode: состояние (умолчание, решение сессии, без сессии —
// каталога) и классификация «меняет / не меняет». Состояние пишется во временные
// каталоги, глобальное умолчание тест не трогает — только читает.

import './env-isolate.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { state, isOn, setMode, resetMode, defaultOn, askGuard, bashMutates } from '../ask-core.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const GUARD = path.join(ROOT, 'claude', 'ask-guard.mjs');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ask-mode-'));
const sub = path.join(tmp, 'client', 'src');
fs.mkdirSync(sub, { recursive: true });
fs.mkdirSync(path.join(tmp, '.git'), { recursive: true });

let pass = 0, fail = 0;
const check = (desc, got, want) => {
  const ok = got === want;
  if (ok) pass++; else fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${desc}  (got=${got}, want=${want})`);
};

const hook = (input) => {
  const out = execFileSync('node', [GUARD], { input: JSON.stringify(input), encoding: 'utf8' });
  return out.trim() ? JSON.parse(out).hookSpecificOutput.permissionDecision : 'allow';
};

// ---- состояние: ключ — сессия ----
const A = `sid-a-${process.pid}`;
const B = `sid-b-${process.pid}`;
check('новая сессия берёт умолчание', state(tmp, A).source, 'по умолчанию');
check('умолчание применилось', state(tmp, A).on, defaultOn());
check('/ask включает', setMode(tmp, true, A), true);
check('решение сессии перекрывает умолчание', state(tmp, A).source, 'сессия');
// Регрессия: вторая сессия в том же каталоге молча сбрасывала /ask первой.
check('соседняя сессия в том же каталоге — свой режим', isOn(tmp, B), defaultOn());
check('reset возвращает умолчание', resetMode(tmp, A), defaultOn());

// ---- без сессии (терминал) — ключ каталога ----
check('/ask-off выключает', setMode(tmp, false), false);
check('решение каталога перекрывает умолчание', state(tmp).source, 'каталог');
check('подкаталог наследует решение корня', isOn(sub), false);
check('решение каталога сессию не задевает', state(tmp, A).source, 'по умолчанию');
resetMode(tmp);

// ---- гард читает режим своей сессии ----
const edit = (session_id) => hook({ cwd: tmp, session_id, tool_name: 'Edit', tool_input: { file_path: 'a.ts' } });
setMode(tmp, true, A);
check('сессия в ask mode: Edit запрещён', edit(A), 'deny');
check('соседняя сессия: Edit разрешён', edit(B), 'allow');
resetMode(tmp, A);

// ---- классификация инструментов ----
setMode(tmp, true);
const cases = [
  ['Edit', { file_path: 'a.ts' }, 'deny'],
  ['Write', { file_path: 'a.ts' }, 'deny'],
  ['Read', { file_path: 'a.ts' }, 'allow'],
  ['mcp__tokensave__tokensave_str_replace', {}, 'deny'],
  ['mcp__tokensave__tokensave_multi_str_replace', {}, 'deny'],
  ['mcp__tokensave__tokensave_read', {}, 'allow'],
  ['mcp__ragsave__rag_search', {}, 'allow'],
  ['Agent', { subagent_type: 'Explore' }, 'allow'],
  ['Agent', { subagent_type: 'general-purpose' }, 'deny'],
  ['Artifact', { action: 'read' }, 'allow'],
  ['Artifact', { action: 'publish' }, 'deny'],
];
for (const [tool, input, want] of cases) {
  check(`${tool}${input.subagent_type ? ` (${input.subagent_type})` : ''}${input.action ? ` (${input.action})` : ''}`,
    hook({ cwd: tmp, tool_name: tool, tool_input: input }), want);
}

// ---- shell ----
const shell = [
  ['npm test', false], ['npm run build -- --watch', false], ['git status --short', false],
  ['git diff HEAD~1', false], ['tsc --noEmit', false], ['docker ps -a', false],
  ['ls -la | grep src', false], ['cat file.txt 2>/dev/null', false],
  ["python3 -c \"import json;print(json.load(open('a.json')))\"", false],
  ['git commit -m x', true], ['git push origin main', true], ['rm -rf dist', true],
  ['echo x > out.txt', true], ['echo x >> out.txt', true], ['npm install axios', true],
  ["sed -i 's/a/b/' a.ts", true], ['docker compose up -d', true], ['systemctl restart nginx', true],
  [`node -e "require('fs').writeFileSync('a','b')"`, true],
  [`python3 -c "open('out.txt','w').write('x')"`, true],
  [`python3 -c "print(open('a.json').read())"`, false],
  [`node -e "const a=1; require('fs').rmSync('dist',{recursive:true})"`, true],
  ['echo "a;b" | tr a b', false],
  // Управление режимом проходит, только когда команда — сам ask-mode.mjs.
  ['node ~/.ai-hooks/bin/ask-mode.mjs off', false],
  ['rm -rf src; echo ask-mode.mjs', true],
  ['rm -rf src # ask-mode.mjs', true],
  // Формы shell, которые прятали запись.
  ['sleep 1 & rm -rf src', true], ['(rm -rf src)', true], ['{ rm -rf src; }', true],
  ['echo $(rm -rf src)', true], ['bash -c "rm -rf src"', true], ["sh -c 'git commit -m x'", true],
  ['eval "rm -rf src"', true], ['bash -c "ls -la"', false], ['sudo -u app rm -rf /srv/x', true],
  ['git -C /tmp/r commit -m x', true], ['git -C /tmp/r status', false],
  ['find . -name "*.log" -delete', true], ['find . -name "*.tmp" -exec rm {} \\;', true],
  ['find . -name "*.ts" -exec grep -l foo {} +', false], ['find . -name "*.ts"', false],
  ['git branch -D feat/x', true], ['git branch --delete feat/x', true], ['git branch -m a b', true],
  ['git branch', false], ['git branch feat/new', true], ['git branch -a --list "feat/*"', false],
  ['npx prettier --write .', true], ['prettier -w src', true], ['pnpm exec eslint --fix src', true],
  ['npx prettier --check .', false], ['npx eslint src', false],
];
for (const [command, want] of shell) {
  check(`bash: ${command}`, bashMutates(command), want);
}

// гард не должен запирать сам себя
check('переключатель режима всегда проходит',
  askGuard('Bash', { command: `node ${ROOT}/bin/ask-mode.mjs off` }), null);

// ---- режим выключен → гард молчит ----
setMode(tmp, false);
check('ask off: Edit разрешён', hook({ cwd: tmp, tool_name: 'Edit', tool_input: { file_path: 'a.ts' } }), 'allow');

resetMode(tmp);
fs.rmSync(tmp, { recursive: true, force: true });

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
process.exit(fail ? 1 : 0);
