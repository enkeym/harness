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
import { DatabaseSync } from 'node:sqlite';
import { guardBash, guardExec, guardRead, isIndexed, breakerAllows, OPENCODE_LABELS } from '../guard-core.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const BASH = path.join(ROOT, 'claude', 'bash-router.mjs');
const READ = path.join(ROOT, 'claude', 'read-router.mjs');

// Что лежит в таблице files индекса: код — да, README и конфиги — нет.
const INDEXED = ['client/src/App.tsx', 'client/src/lib/store/useMarkerStore.ts', 'client/src/index.css', 'client/src/data.json'];

const ON_DISK = [
  'client/src/App.tsx', 'client/src/lib/store/useMarkerStore.ts', 'README.md',
  'client/src/index.css', 'package.json', '.env.example',
  'client/node_modules/storm-ui/dist/index.css', '.ragsave/rag.db', '.ragsave/sync.log',
  '.tokensave/tokensave.db', 'client/src/data.json', 'logs/hooks.jsonl',
];
function sandboxProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ts-guards-project-'));
  for (const rel of ON_DISK) {
    fs.mkdirSync(path.join(dir, path.dirname(rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), '');
  }
  const db = new DatabaseSync(path.join(dir, '.tokensave', 'tokensave.db'));
  db.exec('CREATE TABLE files (path TEXT PRIMARY KEY)');
  const insert = db.prepare('INSERT INTO files (path) VALUES (?)');
  for (const rel of INDEXED) insert.run(rel);
  db.close();
  return dir;
}
const PROJECT = sandboxProject();

// --- Claude: запуск реального хук-скрипта ---
function claude(input) {
  const script = input.tool_name === 'Read' ? READ : BASH;
  try {
    const out = execFileSync('node', [script], { input: JSON.stringify(input), encoding: 'utf8' });
    if (!out.trim()) return 'allow';
    return JSON.parse(out)?.hookSpecificOutput?.permissionDecision || 'allow';
  } catch (e) {
    return 'ERROR:' + e.message;
  }
}

// --- OpenCode: вызов ядра так же, как это делает плагин ---
function opencode(tool, args, directory, sessionID) {
  const reason = tool === 'exec'
    ? guardExec(args.code, directory, OPENCODE_LABELS)
    : tool === 'read'
      ? guardRead(args.filePath, directory, OPENCODE_LABELS, sessionID)
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
  check(`[opencode] ${desc}`, opencode(oc.tool, oc.args, oc.directory, oc.sessionID), want);
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
bash('sed -n по файлу (чтение) → deny', 'deny', "sed -n '1,5p' package.json");
bash('cd && sed -n по файлу → deny', 'deny', `cd ${PROJECT} && sed -n 1,120p client/src/App.tsx`);
bash('awk по файлу → deny', 'deny', "awk '{print $1}' package.json");
bash('sed в пайпе (чтение потока) → allow', 'allow', "git log --oneline | sed -n '1,5p'");
bash('awk в пайпе → allow', 'allow', "git status --short | awk '{print $2}'");
bash('перенаправление в исходник → deny', 'deny', 'echo x > client/src/App.tsx');
bash('перенаправление в новый файл → deny (файлы пишет Write)', 'deny', 'echo x > client/src/__new__.ts');
bash('дозапись в новый файл → deny', 'deny', 'echo x >> notes.txt');
bash('перенаправление в /dev/null → allow', 'allow', 'npm test > /dev/null');
const SCRATCH = path.join(os.tmpdir(), `ts-guards-scratch-${process.pid}.out`);
bash('вывод в /tmp вне проекта → allow', 'allow', `npm test > ${SCRATCH} 2>&1`);
bash('дозапись в /tmp вне проекта → allow', 'allow', `npm test >> ${SCRATCH}`);
bash('перенаправление в проект внутри /tmp → deny', 'deny', `echo x > ${PROJECT}/README.md`);
bash('/tmp/.. наружу → deny', 'deny', 'echo x > /tmp/../ts-guards-outside.txt');
const CLONE = fs.mkdtempSync(path.join(os.tmpdir(), 'ts-guards-clone-'));
fs.mkdirSync(path.join(CLONE, '.git'));
bash('перенаправление в git-клон внутри /tmp без индекса → deny', 'deny', 'npm test > src/a.ts', CLONE);
fs.writeFileSync(SCRATCH, '');
fs.writeFileSync(path.join(CLONE, 'a.ts'), '');
bash('tail черновика в /tmp вне проекта → allow', 'allow', `tail -20 ${SCRATCH}`);
bash('cat черновика и исходника → deny', 'deny', `cat ${SCRATCH} client/src/App.tsx`);
bash('cat файла git-клона внутри /tmp → deny', 'deny', 'cat a.ts', CLONE);
fs.rmSync(SCRATCH, { force: true });
fs.rmSync(CLONE, { recursive: true, force: true });
bash('2>&1 — не файл → allow', 'allow', 'npm test 2>&1');
bash('путь в кавычках в /tmp и 2>&1 → allow', 'allow', 'node t.mjs > "/tmp/t-$f.log" 2>&1', '/tmp');
bash('перенаправление в исходник в кавычках → deny', 'deny', 'echo x > "client/src/App.tsx"');
bash('`>` внутри строки в кавычках → allow', 'allow', `echo "a > b" | wc -l`);
bash('`"` в кавычках подстановки внутри "…" не закрывает строку → allow', 'allow',
  `echo "$(jq -r 'select(.a=="<x>/src</x>")' f)"`);
bash('перенаправление после такой строки → deny', 'deny',
  `echo "$(jq -r '.a=="b"' f)" > client/src/App.tsx`);
bash('экранированная `\\"` строку не открывает → deny', 'deny', 'echo \\"a > client/src/App.tsx');
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
bash('jq по .json вне индекса → allow', 'allow', 'jq .name package.json');
bash('jq по .jsonl вне индекса → allow', 'allow', 'jq -r .ts logs/hooks.jsonl');
bash('jq по .json из индекса → deny', 'deny', 'jq . client/src/data.json');
bash('jq по не-json файлу → deny', 'deny', 'jq -R . client/src/App.tsx');
bash('jq -n без файлов → allow', 'allow', "jq -n '1 + 1'");

// ---- текст отказа называет инструмент, который пройдёт ----
const why = (command) => guardBash(command, PROJECT, OPENCODE_LABELS) || '';
check('cat файла из индекса → tokensave_read', /tokensave_read/.test(why('cat client/src/App.tsx')), true);
check('> в файл из индекса → tokensave_str_replace', /tokensave_str_replace/.test(why('echo x > client/src/App.tsx')), true);
check('git grep → rag_search для конфигов', /rag_search/.test(why('git grep -n foo')), true);

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

// ---- обход родного хука tokensave ----
// Хук сам печатает «set TOKENSAVE_DISABLE_GREP_HOOK=1», а `git grep` не видит.
const OUTSIDE = fs.mkdtempSync(path.join(os.tmpdir(), 'ts-guards-outside-'));
bash('VAR=1 grep → deny', 'deny', 'TOKENSAVE_DISABLE_GREP_HOOK=1 grep -rn isDestroyed --include=*.ts client/src');
bash('env VAR=1 grep → deny', 'deny', 'env TOKENSAVE_DISABLE_GREP_HOOK=1 grep -rn isDestroyed --include=*.ts client/src');
bash('export VAR; grep → deny', 'deny', 'export TOKENSAVE_DISABLE_GREP_HOOK=1; grep -rn isDestroyed client/src');
bash('git grep в индексированном проекте → deny', 'deny', 'git grep -n isDestroyed -- client/src');
bash('cd && git grep в индексированном проекте → deny', 'deny', 'cd client && git grep -n isDestroyed');
bash('git grep вне индекса → allow', 'allow', 'git grep -n isDestroyed', OUTSIDE);
bash('имя переменной в тексте коммита → allow', 'allow', 'git commit -m "fix: deny TOKENSAVE_DISABLE_GREP_HOOK bypass"');
bash('git log/status в индексированном проекте → allow', 'allow', 'git log --oneline -5 && git status --short');
fs.rmSync(OUTSIDE, { recursive: true, force: true });

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
  const reason = guardBash('cat package.json', PROJECT, OPENCODE_LABELS);
  check('[core] причина чтения вне индекса называет read', reason.includes('— read.'), true);
  const edit = guardBash("sed -i 's/a/b/' package.json", PROJECT, OPENCODE_LABELS);
  check('[core] причина правки вне индекса называет edit/write', edit.includes('edit/write'), true);
}

// ---- роутер чтения: файл из индекса → tokensave, остальное проходит ----
// Своя сессия на каждую проверку: предохранитель пропускает повтор той же цели.
let readSeq = 0;
const read = (desc, want, file, cwd = PROJECT, sid = `read-${process.pid}-${readSeq++}`) =>
  both(desc, want,
    { tool_name: 'Read', tool_input: { file_path: path.join(cwd, file) }, cwd, session_id: sid },
    { tool: 'read', args: { filePath: path.join(cwd, file) }, directory: cwd, sessionID: sid + '-oc' });

read('Read файла из индекса → deny', 'deny', 'client/src/App.tsx');
read('Read по относительному пути из подкаталога → deny', 'deny', 'App.tsx', path.join(PROJECT, 'client/src'));
read('Read файла вне индекса (README) → allow', 'allow', 'README.md');
read('Read конфига вне индекса → allow', 'allow', 'package.json');
read('Read нового файла → allow', 'allow', 'client/src/New.tsx');
read('Read вне проекта → allow', 'allow', 'x.ts', os.tmpdir());
read('Read конфига агента внутри проекта → allow', 'allow', '.claude/settings.json');

{
  const sid = `read-breaker-${process.pid}`;
  read('предохранитель: первый Read цели → deny', 'deny', 'client/src/App.tsx', PROJECT, sid);
  read('предохранитель: повтор той же цели → allow', 'allow', 'client/src/App.tsx', PROJECT, sid);
  read('предохранитель: соседний файл той же сессии → deny', 'deny', 'client/src/index.css', PROJECT, sid);
  check('[core] предохранитель: чужая сессия не задета', breakerAllows('other-' + sid, 'Read:/a/x.ts'), false);
  check('[core] isIndexed по файлу индекса', isIndexed(PROJECT, 'client/src/App.tsx'), true);
  check('[core] isIndexed по README', isIndexed(PROJECT, 'README.md'), false);
  const reason = guardRead(path.join(PROJECT, 'client/src/lib/store/useMarkerStore.ts'), PROJECT, OPENCODE_LABELS, sid + '-r');
  check('[core] причина называет tokensave_body и read', reason.includes('tokensave_body') && reason.includes('read'), true);
}

fs.rmSync(PROJECT, { recursive: true, force: true });

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
process.exit(fail ? 1 : 0);
