#!/usr/bin/env node
// Тест ask mode: состояние (умолчание, решение каталога, сброс на старте
// сессии) и классификация «меняет / не меняет». Состояние пишется во временные
// каталоги, глобальное умолчание тест не трогает — только читает.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { state, isOn, setMode, resetMode, defaultOn, askGuard, bashMutates } from '../ask-core.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const GUARD = path.join(ROOT, 'claude', 'ask-guard.mjs');
const SESSION = path.join(ROOT, 'claude', 'ask-session.mjs');

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

// ---- состояние ----
check('новый каталог берёт умолчание', state(tmp).source, 'по умолчанию');
check('умолчание применилось', state(tmp).on, defaultOn());
check('/ask-off выключает', setMode(tmp, false), false);
check('решение каталога перекрывает умолчание', state(tmp).source, 'каталог');
check('подкаталог наследует решение корня', isOn(sub), false);
check('reset возвращает умолчание', resetMode(tmp), defaultOn());

// ---- SessionStart ----
setMode(tmp, false);
execFileSync('node', [SESSION], { input: JSON.stringify({ cwd: tmp, source: 'compact' }) });
check('compact не трогает режим', isOn(tmp), false);
execFileSync('node', [SESSION], { input: JSON.stringify({ cwd: tmp, source: 'startup' }) });
check('startup сбрасывает к умолчанию', isOn(tmp), defaultOn());

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
