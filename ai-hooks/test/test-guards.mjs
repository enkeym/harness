#!/usr/bin/env node
// Тест-харнес shell-гарда. Одни и те же сценарии через ДВА адаптера:
//   - Claude Code: claude/bash-router.mjs (stdin JSON → deny/allow)
//   - OpenCode:    ядро guard-core.mjs с OPENCODE_LABELS (reason → deny/allow)
// Оба должны давать одинаковые вердикты — это и есть проверка паритета.
//
// Правило одно: shell запускает команды; существующий файл через shell не
// читают (Read) и не правят (Edit). Проект — песочница с файлами на диске.

import './env-isolate.mjs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import { guardBash, guardExec, OPENCODE_LABELS } from '../guard-core.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const BASH = path.join(ROOT, 'claude', 'bash-router.mjs');

const ON_DISK = [
  'client/src/App.tsx', 'client/src/lib/store/useMarkerStore.ts', 'README.md',
  'client/src/index.css', 'package.json', '.env.example',
  'client/node_modules/storm-ui/dist/index.css', '.ragsave/rag.db', '.ragsave/sync.log',
];
function sandboxProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ts-guards-project-'));
  for (const rel of ON_DISK) {
    fs.mkdirSync(path.join(dir, path.dirname(rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), '');
  }
  return dir;
}
const PROJECT = sandboxProject();

// --- Claude: запуск реального хук-скрипта ---
function claude(input) {
  try {
    const out = execFileSync('node', [BASH], { input: JSON.stringify(input), encoding: 'utf8' });
    if (!out.trim()) return 'allow';
    return JSON.parse(out)?.hookSpecificOutput?.permissionDecision || 'allow';
  } catch (e) {
    return 'ERROR:' + e.message;
  }
}

// --- OpenCode: вызов ядра так же, как это делает плагин ---
function opencode(tool, args, directory) {
  const reason = tool === 'exec'
    ? guardExec(args.code, directory, OPENCODE_LABELS)
    : guardBash(args.command, directory, OPENCODE_LABELS);
  return reason ? 'deny' : 'allow';
}

let pass = 0, fail = 0;
function check(desc, got, want) {
  const ok = got === want;
  if (ok) pass++; else fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${desc}  (got=${got}, want=${want})`);
}

function both(desc, want, cc, oc) {
  check(`[claude]   ${desc}`, claude(cc), want);
  check(`[opencode] ${desc}`, opencode(oc.tool, oc.args, oc.directory), want);
}

const bash = (desc, want, command, cwd = PROJECT) =>
  both(desc, want,
    { tool_name: 'Bash', tool_input: { command }, cwd },
    { tool: 'bash', args: { command }, directory: cwd });

// ---- чтение содержимого ----
bash('cat исходника → deny', 'deny', 'cat client/src/App.tsx');
bash('head/tail исходника → deny', 'deny', 'head -50 client/src/App.tsx');
bash('cat по абсолютному пути → deny', 'deny', `cat ${PROJECT}/client/src/App.tsx`);
bash('cat внутри пайплайна → deny', 'deny', 'cat client/src/App.tsx | head -5');
bash('cat package.json → deny', 'deny', 'cat package.json');
bash('cat .env.example → deny (это тоже файл)', 'deny', 'cat .env.example');
bash('cat вендорного файла → deny', 'deny', 'cat client/node_modules/storm-ui/dist/index.css');
bash('cat несуществующего файла → allow', 'allow', 'cat client/src/__nope__.ts');
bash('cat вне проекта, файла нет → allow', 'allow', 'cat /tmp/__nope__.ts', '/tmp');

// ---- правка на месте ----
bash('sed -i по исходнику → deny', 'deny', "sed -i 's/a/b/' client/src/App.tsx");
bash('sed БЕЗ -i (чтение потока) → allow', 'allow', "sed -n '1,5p' package.json");
bash('перенаправление в исходник → deny', 'deny', 'echo x > client/src/App.tsx');
bash('перенаправление в новый файл → deny (файлы пишет Write)', 'deny', 'echo x > client/src/__new__.ts');
bash('дозапись в новый файл → deny', 'deny', 'echo x >> notes.txt');
bash('перенаправление в /dev/null → allow', 'allow', 'npm test > /dev/null');
bash('2>&1 — не файл → allow', 'allow', 'npm test 2>&1');
bash('tee в исходник → deny', 'deny', 'echo x | tee client/src/App.tsx');
bash('`=>` в строке — не перенаправление → allow', 'allow', `git log --format='%h => %s'`);

// ---- интерпретаторы: путь спрятан в строке кода ----
bash('python -c с чтением исходника → deny', 'deny',
  `python3 -c "print(open('client/src/App.tsx').read())"`);
bash('node -e с записью в исходник → deny', 'deny',
  `node -e "require('fs').writeFileSync('client/src/App.tsx','x')"`);
bash('node -e по package.json → deny', 'deny', `node -e "require('./package.json')"`);
// Скрипт как аргумент — запуск, не чтение.
bash('node <скрипт> → allow (запуск)', 'allow', 'node client/src/App.tsx');
bash('python3 <скрипт> → allow (запуск)', 'allow', 'python3 client/src/App.tsx --flag');
bash('node с heredoc и путём → deny', 'deny',
  `node <<'EOF'\nconsole.log(require('fs').readFileSync('client/src/App.tsx','utf8'))\nEOF`);
// Тело heredoc — код интерпретатора, а не команды shell: `&`, `(`, `;` в нём
// не режут сегмент, и путь остаётся рядом с `node`.
bash('node с heredoc, в теле скобки и & → deny', 'deny',
  `node <<'EOF'\nif (1) require('fs').writeFileSync('client/src/App.tsx', 'x') & 0\nEOF`);
bash('heredoc: `=>` в теле — не перенаправление → allow', 'allow',
  `node <<'EOF'\nconst f = (a) => a + 1; console.log(f(1))\nEOF`);
bash('node <<\\EOF с путём → deny', 'deny',
  `node <<\\EOF\nrequire('fs').readFileSync('client/src/App.tsx')\nEOF`);
bash('heredoc, за которым `;` на той же строке → тело у node → deny', 'deny',
  `node <<'EOF'; true\nrequire('fs').readFileSync('client/src/App.tsx')\nEOF`);
bash('<< в кавычках — не heredoc, следующая строка — команда → deny', 'deny',
  `echo "a<<X"\ncat client/src/App.tsx`);
bash('node -p с путём → deny', 'deny',
  `node -p "require('fs').readFileSync('client/src/App.tsx','utf8')"`);
bash('jq по package.json → deny', 'deny', 'jq .name package.json');

// ---- формы команды, которые разбирает shell-core ----
bash('фоновый & перед cat → deny', 'deny', 'echo ok & cat client/src/App.tsx');
bash('cat в подстановке $(…) → deny', 'deny', 'echo $(cat client/src/App.tsx)');
bash('cat в обратных кавычках → deny', 'deny', 'echo `cat client/src/App.tsx`');
bash('sudo -u root cat → deny', 'deny', 'sudo -u root cat client/src/App.tsx');
bash('cat в группе ( … ) → deny', 'deny', '(cat client/src/App.tsx)');
bash('then cat → deny', 'deny', 'if true; then cat client/src/App.tsx; fi');
bash('xargs cat → deny', 'deny', 'echo x | xargs cat client/src/App.tsx');
bash('2>&1 и фоновый git по исходнику → allow', 'allow', 'git log client/src/App.tsx 2>&1 & wait');

// ---- grep и вывод команд — не чтение файла ----
bash('grep -rn по коду → allow', 'allow', 'grep -rn useState client/src');
bash('grep с --include → allow', 'allow', 'grep -rn foo --include=*.json .');
bash('rg по файлу → allow', 'allow', 'rg range client/src/App.tsx');
bash('ps | grep → allow', 'allow', 'ps aux | grep ragsave');
bash('cat исходника | grep → deny (виноват cat)', 'deny', 'cat client/src/App.tsx | grep useState');

// ---- легитимные инструменты над теми же путями ----
bash('git diff по исходнику → allow', 'allow', 'git diff client/src/App.tsx');
bash('tsc по исходнику → allow', 'allow', 'npx tsc --noEmit client/src/App.tsx');
bash('eslint по исходнику → allow', 'allow', 'npx eslint client/src/App.tsx');
bash('ragsave sync с путём проекта → allow', 'allow', `ragsave sync ${PROJECT}`);
bash('ragsave search с именем файла в запросе → allow', 'allow', 'ragsave search "что делает App.tsx"');
bash('пустая команда → allow', 'allow', '');

// ---- mcp__ide__executeCode: тот же канал, то же правило ----
both('executeCode с путём файла → deny', 'deny',
  { tool_name: 'mcp__ide__executeCode', tool_input: { code: "open('client/src/App.tsx').read()" }, cwd: PROJECT },
  { tool: 'exec', args: { code: "open('client/src/App.tsx').read()" }, directory: PROJECT });

both('executeCode без путей → allow', 'allow',
  { tool_name: 'mcp__ide__executeCode', tool_input: { code: 'print(2 + 2)' }, cwd: PROJECT },
  { tool: 'exec', args: { code: 'print(2 + 2)' }, directory: PROJECT });

// ---- причина называет замену ----
{
  const reason = guardBash('cat client/src/App.tsx', PROJECT, OPENCODE_LABELS);
  check('[core] причина чтения называет read', reason.includes('read'), true);
  const edit = guardBash("sed -i 's/a/b/' client/src/App.tsx", PROJECT, OPENCODE_LABELS);
  check('[core] причина правки называет edit/write', edit.includes('edit/write'), true);
}

fs.rmSync(PROJECT, { recursive: true, force: true });

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
process.exit(fail ? 1 : 0);
