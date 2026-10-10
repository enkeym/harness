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
  '.tokensave/tokensave.db', 'client/src/data.json', 'logs/hooks.jsonl', 'logs/events.ndjson',
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
bash('`>` как сравнение в [[ ]] → allow', 'allow', '[[ "$S" > "20:20:00" ]] && echo new');
bash('перенаправление после [[ ]] → deny', 'deny', '[[ -n "$a" ]] && echo x > client/src/App.tsx');
bash('`>` после && внутри [[ ]] → allow', 'allow', '[[ -n "$a" && "$S" > "20:20:00" ]] && echo new');
bash('`>` в (( )) → allow', 'allow', '(( n > 5 )) && echo big');
bash('`>` в $(( )) → allow', 'allow', 'echo $(( a > b ))');
bash('`>` и `;` в for (( )) → allow', 'allow', 'for ((i=0; i>5; i++)); do :; done');
bash('перенаправление после (( )) → deny', 'deny', '(( n > 5 )) && echo x > client/src/App.tsx');
bash('`[[` словом echo — перенаправление настоящее → deny', 'deny', 'echo [[ > client/src/App.tsx ]]');
bash('`]]` в кавычках не закрывает условие → deny', 'deny', 'if [[ "$x" == "]]" ]]; then echo x > client/src/App.tsx; fi');
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

// ---- равносильные формы чтения: печатают файл целиком, как cat ----
bash('diff /dev/null исходника → deny', 'deny', 'diff /dev/null client/src/App.tsx');
bash('diff -u исходника и /dev/null → deny', 'deny', 'diff -u client/src/App.tsx /dev/null');
bash('git diff --no-index /dev/null исходника → deny', 'deny', 'git diff --no-index /dev/null client/src/App.tsx');
bash('diff двух файлов проекта → allow (сравнение)', 'allow', 'diff README.md package.json');
bash("grep '' по файлу → deny", 'deny', "grep '' client/src/App.tsx");
bash('grep . по файлу → deny', 'deny', 'grep . client/src/App.tsx');
bash('grep -n ^ по файлу → deny', 'deny', 'grep -n ^ client/src/App.tsx');
bash('grep -v по файлу → deny', 'deny', 'grep -v zzzz client/src/App.tsx');
bash('grep -cv по файлу → allow (счёт)', 'allow', 'grep -cv zzzz client/src/App.tsx');
bash('grep -v в пайпе → allow', 'allow', 'ps aux | grep -v grep');
bash('grep -v с путём-шаблоном в пайпе → allow (шаблон, не файл)', 'allow', "git ls-files | grep -v '^client/src/App.tsx'");
bash('grep -e путь-шаблон в пайпе → allow', 'allow', 'git ls-files | grep -ve client/src/App.tsx');
bash('grep -v путь-шаблон по файлу → deny (виноват файл)', 'deny', 'grep -v client/src/App.tsx README.md');
bash('grep -v < файл → deny', 'deny', 'grep -v zzzz < client/src/App.tsx');
bash('grep -v <файл слитно → deny', 'deny', 'grep -v zzzz <client/src/App.tsx');
bash('grep -e . по файлу → deny', 'deny', 'grep -e . client/src/App.tsx');
bash('grep -n -A30 шаблон по файлу → allow (поиск)', 'allow', 'grep -n -A30 useState client/src/App.tsx');
for (const c of ['base64', 'hexdump -C', 'cut -c1-', 'sort', 'uniq', 'paste', 'fold', 'pr', 'column -t', 'expand']) {
  bash(`${c} по файлу → deny`, 'deny', `${c} client/src/App.tsx`);
}
bash('sort | uniq в пайпе → allow', 'allow', 'git log --format=%an | sort | uniq -c');

// Тело `bash -c`, `eval` и `bash <<EOF` — те же команды.
bash('bash -c "cat …" → deny', 'deny', 'bash -c "cat client/src/App.tsx"');
bash("sh -c 'head …' → deny", 'deny', "sh -c 'head -5 client/src/App.tsx'");
bash('bash -lc с запуском → allow', 'allow', 'bash -lc "npm test"');
bash('bash скрипта → allow (запуск)', 'allow', 'bash client/src/App.tsx');
bash('eval "cat …" → deny', 'deny', 'eval "cat client/src/App.tsx"');
bash('bash <<EOF с cat в теле → deny', 'deny', "bash <<'EOF'\ncat client/src/App.tsx\nEOF");
bash('vim -es по файлу → deny', 'deny', "vim -es -c '%p' -c q client/src/App.tsx");
bash('ex -sc по файлу → deny', 'deny', "ex -sc '%p|q' client/src/App.tsx");
bash('ed -s по файлу → deny', 'deny', "ed -s client/src/App.tsx <<< $'1d\\nw'");

// Интерпретатор с версией или из Windows (`python.exe` из WSL) — тот же интерпретатор.
bash('python.exe -c с путём → deny', 'deny', `python.exe -c "print(open('client/src/App.tsx').read())"`);
bash('python3.12 -c с путём → deny', 'deny', `python3.12 -c "print(open('client/src/App.tsx').read())"`);
bash('tsx -e с путём → deny', 'deny', `tsx -e "require('fs').readFileSync('client/src/App.tsx')"`);
bash('python.exe - <<EOF с записью → deny', 'deny', `python.exe - <<'EOF'\nopen('client/src/App.tsx','w').write('x')\nEOF`);
bash('python3.12 <скрипт> → allow (запуск)', 'allow', 'python3.12 client/src/App.tsx');
// Флаги после скрипта или модуля — его аргументы, а не код: `-p` у pytest — плагин.
bash('python.exe -m pytest с -p → allow (запуск)', 'allow', 'python.exe -m pytest client/src/App.tsx -q -p no:cacheprovider');
const PT = path.join(os.tmpdir(), `ts-guards-pt-${process.pid}.txt`);
fs.writeFileSync(PT, '');
bash('python -m pytest > /tmp; grep по выводу → allow', 'allow',
  `python3 -m pytest -p no:cacheprovider > ${PT} 2>&1; grep -E "FAILED|passed" ${PT}`);
fs.rmSync(PT, { force: true });
bash('python3 <скрипт> -c x → allow (аргумент скрипта)', 'allow', 'python3 client/src/App.tsx -c x');
bash('node -r модуль <скрипт> → allow (запуск)', 'allow', 'node -r dotenv/config client/src/App.tsx args');
bash('node -r модуль -e с путём → deny', 'deny', `node -r dotenv/config -e "require('./package.json')"`);
bash('perl -I каталог -e с путём → deny', 'deny', `perl -I lib -e "print 1" client/src/App.tsx`);
bash('php -r с путём → deny', 'deny', `php -r "echo file_get_contents('client/src/App.tsx');"`);

// ---- копия в /tmp — то же чтение, копия поверх файла — та же запись ----
const DRAFT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ts-guards-draft-'));
const DRAFT = path.join(DRAFT_DIR, 'App.tsx');
fs.writeFileSync(DRAFT, '');
bash('cp исходника в /tmp → deny', 'deny', `cp client/src/App.tsx ${DRAFT_DIR}/g`);
bash('cp в /tmp && cat копии → deny', 'deny', `cp client/src/App.tsx ${DRAFT_DIR}/g && cat ${DRAFT_DIR}/g`);
bash('rsync исходника в /tmp → deny', 'deny', `rsync client/src/App.tsx ${DRAFT_DIR}/`);
bash('cp -t /tmp исходника → deny', 'deny', `cp -t ${DRAFT_DIR} client/src/App.tsx`);
bash('cp -r каталога в /tmp → allow', 'allow', `cp -r client ${DRAFT_DIR}/copy`);
bash('cp исходника в новый файл проекта → allow', 'allow', 'cp client/src/App.tsx client/src/App.bak.tsx');
bash('mv в новый файл (переименование) → allow', 'allow', 'mv README.md NOTES.md');
bash('cp между черновиками → allow', 'allow', `cp ${DRAFT} ${DRAFT_DIR}/y.tsx`);
bash('cp черновика поверх файла проекта → deny', 'deny', `cp ${DRAFT} client/src/App.tsx`);
bash('mv поверх файла проекта → deny', 'deny', 'mv README.md client/src/App.tsx');
bash('cp /dev/null поверх файла → deny', 'deny', 'cp /dev/null client/src/App.tsx');
bash('cp в каталог, где такой файл есть → deny', 'deny', `cp ${DRAFT} client/src/`);
bash('mv -f поверх файла проекта → deny', 'deny', `mv -f ${DRAFT} client/src/App.tsx`);
fs.symlinkSync(path.join(PROJECT, 'client/src/App.tsx'), path.join(DRAFT_DIR, 'link.tsx'));
bash('cat ссылки из /tmp на исходник → deny', 'deny', `cat ${DRAFT_DIR}/link.tsx`);
bash('cat своего черновика → allow', 'allow', `cat ${DRAFT}`);
bash('ln -s $PWD/исходника в /tmp && cat → deny', 'deny', `ln -s $PWD/client/src/App.tsx ${DRAFT_DIR}/l2 && cat ${DRAFT_DIR}/l2`);

// ---- jq: файлы — операнды после фильтра, а не строки внутри него ----
bash('jq с путём исходника в строке фильтра → allow', 'allow',
  `jq -r 'select(.file=="client/src/App.tsx") | .ts' logs/hooks.jsonl`);
bash('jq по .ndjson вне индекса → allow', 'allow', 'jq -c keys logs/events.ndjson');
bash('jq --rawfile исходника → deny', 'deny', `jq -n --rawfile s client/src/App.tsx '$s'`);
bash('jq < файла из индекса → deny', 'deny', 'jq . < client/src/data.json');
bash('jq по черновику в /tmp → allow', 'allow', `jq -R . ${DRAFT}`);
bash('jq --arg со значением-путём → allow', 'allow', `jq --arg f client/src/App.tsx '.[$f]' logs/hooks.jsonl`);
fs.rmSync(DRAFT_DIR, { recursive: true, force: true });

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

// `git grep` по чужой ревизии ищет код, которого нет в индексе (ревью МР);
// по рабочему дереву — обход. Репозиторий: `old` — первый коммит, `main` — HEAD.
const REPO = sandboxProject();
const git = (...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: REPO, encoding: 'utf8' }).trim();
git('init', '-q', '-b', 'main');
git('add', 'client/src/App.tsx');
git('commit', '-qm', 'a');
git('branch', 'old');
git('add', 'README.md');
git('commit', '-qm', 'b');
const HEAD_SHA = git('rev-parse', 'HEAD');
const OLD_SHA = git('rev-parse', 'old');
const repo = (desc, want, command) => bash(desc, want, command, REPO);
repo('git grep по sha другого коммита → allow', 'allow', `git grep -n foo ${OLD_SHA} -- client/src`);
repo('git grep по другой ветке → allow', 'allow', 'git grep -n foo old');
repo('git grep по <ветка>:<путь> → allow', 'allow', 'git grep -n foo old:client/src');
repo('git grep -ne шаблон ревизия → allow', 'allow', 'git grep -ne foo old');
repo('git grep -A 3 шаблон ревизия → allow', 'allow', 'git grep -A 3 foo old');
repo('git grep --max-count 2 шаблон ревизия → allow', 'allow', 'git grep --max-count 2 foo old');
repo('git --no-pager grep по другой ветке → allow', 'allow', 'git --no-pager grep -n foo old');
repo('git grep без ревизии → deny', 'deny', 'git grep -n foo -- client/src');
repo('git grep по пути без -- → deny', 'deny', 'git grep -n foo client/src');
repo('git grep по HEAD → deny', 'deny', 'git grep -n foo HEAD');
repo('git grep по @ → deny', 'deny', 'git grep -n foo @');
repo('git grep по текущей ветке → deny', 'deny', 'git grep -n foo main');
repo('git grep по sha самого HEAD → deny', 'deny', `git grep -n foo ${HEAD_SHA}`);
repo('git grep по :<путь> (индекс git) → deny', 'deny', 'git grep -n foo :client/src');
repo('git grep по другой ветке и HEAD → deny', 'deny', 'git grep -n foo old HEAD');
repo('git grep по $переменной → deny', 'deny', `H=${OLD_SHA}; git grep -n foo $H`);
repo('шаблон совпал с именем ветки → deny', 'deny', 'git grep -n old');
repo('шаблон через -e, ветки нет → deny', 'deny', 'git grep -e old client/src');
repo('git -C . grep без ревизии → deny', 'deny', 'git -C . grep -n foo');

// `git show <ревизия>:<путь>` — тот же файл, что в рабочем дереве, если ревизия — HEAD.
repo('git show HEAD:<файл> → deny', 'deny', 'git show HEAD:client/src/App.tsx');
repo('git show @:<файл> → deny', 'deny', 'git show @:client/src/App.tsx');
repo('git show :<файл> (индекс git) → deny', 'deny', 'git show :client/src/App.tsx');
repo('git show <текущая ветка>:<файл> → deny', 'deny', 'git show main:client/src/App.tsx');
repo('git show HEAD:<файл> | sed → deny', 'deny', 'git show HEAD:client/src/App.tsx | sed -n 1,20p');
repo('git cat-file -p HEAD:<файл> → deny', 'deny', 'git cat-file -p HEAD:client/src/App.tsx');
repo('git show HEAD:<файл вне индекса> → deny', 'deny', 'git show HEAD:README.md');
repo('git show <другая ветка>:<файл> → allow', 'allow', 'git show old:client/src/App.tsx');
repo('git show <sha другого коммита>:<файл> → allow', 'allow', `git show ${OLD_SHA}:client/src/App.tsx`);
repo('git show HEAD~1:<файл> → allow', 'allow', 'git show HEAD~1:client/src/App.tsx');
repo('git show HEAD --stat → allow', 'allow', 'git show HEAD --stat');
repo('git show HEAD:<каталог> → allow', 'allow', 'git show HEAD:client/src');
check('отказ git show HEAD: называет tokensave_read', /tokensave_read/.test(guardBash('git show HEAD:client/src/App.tsx', REPO, OPENCODE_LABELS) || ''), true);
check('отказ git grep называет ревизию', /<sha\|ветка>/.test(guardBash('git grep -n foo', REPO, OPENCODE_LABELS) || ''), true);
fs.rmSync(REPO, { recursive: true, force: true });

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
