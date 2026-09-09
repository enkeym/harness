#!/usr/bin/env node
// Тест-харнес для гард-хуков tokensave.
// Прогоняет одни и те же сценарии через ДВА адаптера:
//   - Claude Code: скрипты claude/*.mjs (stdin JSON → deny/allow)
//   - OpenCode:    ядро guard-core.mjs с OPENCODE_LABELS (reason → deny/allow)
// Оба должны давать одинаковые вердикты — это и есть проверка паритета.
//
// Правило одно: файл в индексе tokensave → deny; нет в индексе → allow.
// Поэтому пути ниже — реальные файлы web_groza, а не выдуманные: вердикт
// зависит от содержимого .tokensave/tokensave.db.

import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import {
  guardRead, guardGrep, guardEdit, guardBash, guardExec, OPENCODE_LABELS,
  isIndexed, indexedExtensions, breakerAllows,
} from '../guard-core.mjs';
import { statePath } from '../state-core.mjs';

const BREAKER_FILE = statePath('guard-breaker.json');

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const READ = path.join(ROOT, 'claude', 'read-search-router.mjs');
const EDIT = path.join(ROOT, 'claude', 'edit-router.mjs');
const BASH = path.join(ROOT, 'claude', 'bash-router.mjs');

// tokensave-проект: web_groza (есть .tokensave). Не-проект: /tmp.
const TS_PROJECT = '/home/enkeym/main/web_groza';
const NON_PROJECT = '/tmp';

// Состав индекса зависит от ветки: на main в графе только ts/js/tsx/md, на
// рабочих ветках туда попадают ещё json, sql, yml. Поэтому вердикт для таких
// файлов не константа — берём его из той же БД, по которой судит гард.
const EXTS = indexedExtensions(TS_PROJECT) || new Set();
const PKG_JSON = TS_PROJECT + '/package.json';
const wantExt = (ext) => (EXTS.has(ext) ? 'deny' : 'allow');
const wantFile = (file) => (isIndexed(TS_PROJECT, file) ? 'deny' : 'allow');
const JSON_VERDICT = wantFile(PKG_JSON);

// --- Claude: запуск реального хук-скрипта ---
function claude(script, input) {
  try {
    const out = execFileSync('node', [script], {
      input: JSON.stringify(input),
      encoding: 'utf8',
    });
    if (!out.trim()) return 'allow';
    return JSON.parse(out)?.hookSpecificOutput?.permissionDecision || 'allow';
  } catch (e) {
    return 'ERROR:' + e.message;
  }
}

// --- OpenCode: вызов ядра так же, как это делает плагин ---
function opencode(tool, args, directory) {
  let reason = null;
  switch (tool) {
    case 'read':
      reason = guardRead(args.filePath, directory, OPENCODE_LABELS);
      break;
    case 'grep':
      reason = guardGrep({ path: args.path, glob: args.include }, directory, OPENCODE_LABELS);
      break;
    case 'edit':
    case 'write':
      reason = guardEdit(args.filePath, directory, OPENCODE_LABELS);
      break;
    case 'bash':
      reason = guardBash(args.command, directory, OPENCODE_LABELS);
      break;
    case 'exec':
      reason = guardExec(args.code, directory, OPENCODE_LABELS);
      break;
  }
  return reason ? 'deny' : 'allow';
}

let pass = 0, fail = 0;
function check(desc, got, want) {
  const ok = got === want;
  if (ok) pass++; else fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${desc}  (got=${got}, want=${want})`);
}

// Один сценарий → два harness'а. cc/oc — вход в терминах каждого агента.
function both(desc, want, cc, oc) {
  const script = ['Edit', 'Write'].includes(cc.tool_name) ? EDIT
    : ['Bash', 'mcp__ide__executeCode'].includes(cc.tool_name) ? BASH
    : READ;
  check(`[claude]   ${desc}`, claude(script, cc), want);
  check(`[opencode] ${desc}`, opencode(oc.tool, oc.args, oc.directory), want);
}

const read = (desc, want, file, cwd = TS_PROJECT) =>
  both(desc, want,
    { tool_name: 'Read', tool_input: { file_path: file }, cwd },
    { tool: 'read', args: { filePath: file }, directory: cwd });

// ---- READ: в индексе → deny ----
read('read .tsx из индекса → deny', 'deny', TS_PROJECT + '/client/src/App.tsx');
read('read .ts из индекса → deny', 'deny', TS_PROJECT + '/client/src/lib/store/useMarkerStore.ts');
read('read README.md из индекса → deny (tokensave индексирует md)', 'deny', TS_PROJECT + '/README.md');

// ---- READ: нет в индексе → allow (тот самый баг: раньше был тупик) ----
// .css в src: попадёт в граф или нет — зависит от состава ветки, поэтому вердикт
// берём из той же БД (как для package.json), а не литералом. Регрессию «тупика»
// стережёт кейс .css в node_modules ниже — тот не будет в индексе никогда.
read('read .css в src → по индексу активной ветки',
  wantFile(TS_PROJECT + '/client/src/index.css'), TS_PROJECT + '/client/src/index.css');
read('read package.json → по индексу активной ветки', JSON_VERDICT, PKG_JSON);
read('read несуществующего .ts → allow', 'allow', TS_PROJECT + '/client/src/__nope__.ts');
read('read конфига агента (.ai-hooks) → allow', 'allow', '/home/enkeym/.ai-hooks/guard-core.mjs');
read('read конфига агента (.config/opencode) → allow', 'allow',
  '/home/enkeym/.config/opencode/plugin/tokensave-guard.js');
read('read исходника вне tokensave-проекта → allow', 'allow', NON_PROJECT + '/foo.ts', NON_PROJECT);

// ---- GREP ----
both('grep glob/include *.ts → deny', 'deny',
  { tool_name: 'Grep', tool_input: { pattern: 'x', glob: '*.ts', path: TS_PROJECT }, cwd: TS_PROJECT },
  { tool: 'grep', args: { pattern: 'x', include: '*.ts', path: TS_PROJECT }, directory: TS_PROJECT });

both('grep glob/include *.json → по индексу активной ветки', wantExt('.json'),
  { tool_name: 'Grep', tool_input: { pattern: 'x', glob: '*.json', path: TS_PROJECT }, cwd: TS_PROJECT },
  { tool: 'grep', args: { pattern: 'x', include: '*.json', path: TS_PROJECT }, directory: TS_PROJECT });

both('grep без ограничения (broad) → deny', 'deny',
  { tool_name: 'Grep', tool_input: { pattern: 'x', path: TS_PROJECT }, cwd: TS_PROJECT },
  { tool: 'grep', args: { pattern: 'x', path: TS_PROJECT }, directory: TS_PROJECT });

both('grep по конфигу агента → allow', 'allow',
  { tool_name: 'Grep', tool_input: { pattern: 'x', path: '/home/enkeym/.claude' }, cwd: TS_PROJECT },
  { tool: 'grep', args: { pattern: 'x', path: '/home/enkeym/.claude' }, directory: TS_PROJECT });

both('grep вне tokensave-проекта → allow', 'allow',
  { tool_name: 'Grep', tool_input: { pattern: 'x', path: NON_PROJECT }, cwd: NON_PROJECT },
  { tool: 'grep', args: { pattern: 'x', path: NON_PROJECT }, directory: NON_PROJECT });

// регрессия: конкретный .css/.js в node_modules НЕ в индексе, хоть .css/.ts и
// индексируются в src → allow (раньше ложно блокировалось по расширению)
both('grep по .css в node_modules → allow', 'allow',
  { tool_name: 'Grep', tool_input: { pattern: 'range', path: TS_PROJECT + '/client/node_modules/storm-ui/dist/index.css' }, cwd: TS_PROJECT },
  { tool: 'grep', args: { pattern: 'range', path: TS_PROJECT + '/client/node_modules/storm-ui/dist/index.css' }, directory: TS_PROJECT });

both('grep по каталогу node_modules → allow', 'allow',
  { tool_name: 'Grep', tool_input: { pattern: 'range', path: TS_PROJECT + '/client/node_modules/storm-ui' }, cwd: TS_PROJECT },
  { tool: 'grep', args: { pattern: 'range', path: TS_PROJECT + '/client/node_modules/storm-ui' }, directory: TS_PROJECT });

// ---- BASH: shell не должен подменять tokensave на индексированных файлах ----
const bash = (desc, want, command, cwd = TS_PROJECT) =>
  both(desc, want,
    { tool_name: 'Bash', tool_input: { command }, cwd },
    { tool: 'bash', args: { command }, directory: cwd });

// чтение содержимого
bash('cat исходника из индекса → deny', 'deny', 'cat client/src/App.tsx');
bash('head/tail исходника → deny', 'deny', 'head -50 client/src/App.tsx');
bash('cat по абсолютному пути → deny', 'deny', `cat ${TS_PROJECT}/client/src/App.tsx`);
bash('cat внутри пайплайна → deny', 'deny', 'cat client/src/App.tsx | head -5');
bash('cat package.json → по индексу активной ветки', JSON_VERDICT, 'cat package.json');
bash('cat вне tokensave-проекта → allow', 'allow', 'cat /tmp/foo.ts', NON_PROJECT);

// правка на месте
bash('sed -i по исходнику → deny', 'deny', "sed -i 's/a/b/' client/src/App.tsx");
bash('sed БЕЗ -i (чтение потока) → allow', 'allow', "sed -n '1,5p' package.json");
bash('перенаправление в исходник → deny', 'deny', 'echo x > client/src/App.tsx');
bash('перенаправление в новый файл → allow', 'allow', 'echo x > client/src/__new__.ts');
bash('tee в исходник → deny', 'deny', 'echo x | tee client/src/App.tsx');

// интерпретаторы: путь спрятан в строке кода
bash('python -c с чтением исходника → deny', 'deny',
  `python3 -c "print(open('client/src/App.tsx').read())"`);
bash('node -e с записью в исходник → deny', 'deny',
  `node -e "require('fs').writeFileSync('client/src/App.tsx','x')"`);
bash('node -e по package.json → по индексу активной ветки', JSON_VERDICT,
  `node -e "require('./package.json')"`);

// grep-семейство
bash('grep -rn по коду → deny', 'deny', 'grep -rn useState client/src');
bash('rg по коду → deny', 'deny', 'rg useState client/src');
bash('grep с --include=*.json → по индексу активной ветки', wantExt('.json'),
  'grep -rn foo --include=*.json .');
bash('rg по .css в node_modules → allow (регрессия)', 'allow',
  'rg range client/node_modules/storm-ui/dist/index.css');
bash('rg по каталогу node_modules → allow (регрессия)', 'allow',
  'rg range client/node_modules/storm-ui');

// grep из пайпа читает stdin, а не файлы. Раньше блокировался любой такой
// вызов: паттерн отбрасывался, путей не оставалось, и запрет срабатывал на
// пустом месте. Это ловило обычную работу с выводом команд и толкало в обход.
bash('ps | grep → allow (stdin, не файлы)', 'allow', 'ps aux | grep ragsave');
bash('git log | grep → allow', 'allow', 'git log --oneline | grep fix');
bash('env | grep → allow', 'allow', 'env | grep PATH');
bash('npm ls | grep → allow', 'allow', 'npm ls | grep react');
bash('docker ps | grep → allow', 'allow', 'docker ps | grep -c app');
bash('ls | grep с именем файла из индекса → allow (это stdin)', 'allow',
  'ls -la client/src | grep App.tsx');
bash('grep в конце длинного пайпа → вердикт за cat package.json', JSON_VERDICT,
  'cat package.json | jq .name | grep -i groza');
bash('grep после && (не пайп, без путей) → allow', 'allow',
  'npm run build && grep -c done');

// grep без путей и без рекурсии тоже читает stdin
bash('голый grep без путей → allow', 'allow', 'grep useState');
bash('grep -i без путей → allow', 'allow', 'grep -i usestate');

// ...но рекурсия по текущему каталогу — уже обход поиска по коду
bash('grep -r без пути → deny (рекурсия по проекту)', 'deny', 'grep -r useState');
bash('grep -rn без пути → deny', 'deny', 'grep -rn useState');
bash('rg без пути → deny (rg рекурсивен по умолчанию)', 'deny', 'rg useState');
bash('grep --recursive без пути → deny', 'deny', 'grep --recursive useState');

// пайп не должен прикрывать чтение файла слева
bash('cat исходника | grep → deny (виноват cat)', 'deny',
  'cat client/src/App.tsx | grep useState');
bash('grep по package.json и в пайп → по индексу активной ветки', JSON_VERDICT,
  'grep name package.json | head -3');

// длинные опции с буквой r в названии не должны читаться как рекурсия
bash('grep --color по package.json → по индексу активной ветки', JSON_VERDICT,
  'grep --color=always -n name package.json');

// легитимные инструменты над теми же путями — не трогаем
bash('git diff по исходнику → allow', 'allow', 'git diff client/src/App.tsx');
bash('tsc по исходнику → allow', 'allow', 'npx tsc --noEmit client/src/App.tsx');
bash('eslint по исходнику → allow', 'allow', 'npx eslint client/src/App.tsx');
bash('пустая команда → allow', 'allow', '');

// ---- mcp__ide__executeCode: тот же канал, то же правило ----
both('executeCode с путём из индекса → deny', 'deny',
  { tool_name: 'mcp__ide__executeCode', tool_input: { code: "open('client/src/App.tsx').read()" }, cwd: TS_PROJECT },
  { tool: 'exec', args: { code: "open('client/src/App.tsx').read()" }, directory: TS_PROJECT });

both('executeCode без путей из индекса → allow', 'allow',
  { tool_name: 'mcp__ide__executeCode', tool_input: { code: 'print(2 + 2)' }, cwd: TS_PROJECT },
  { tool: 'exec', args: { code: 'print(2 + 2)' }, directory: TS_PROJECT });

// ---- EDIT / WRITE ----
both('edit файла из индекса → deny', 'deny',
  { tool_name: 'Edit', tool_input: { file_path: TS_PROJECT + '/client/src/lib/store/useMarkerStore.ts' }, cwd: TS_PROJECT },
  { tool: 'edit', args: { filePath: TS_PROJECT + '/client/src/lib/store/useMarkerStore.ts' }, directory: TS_PROJECT });

both('write НОВОГО файла → allow (в индексе его нет)', 'allow',
  { tool_name: 'Write', tool_input: { file_path: TS_PROJECT + '/client/src/__brand_new__.ts' }, cwd: TS_PROJECT },
  { tool: 'write', args: { filePath: TS_PROJECT + '/client/src/__brand_new__.ts' }, directory: TS_PROJECT });

both('edit .css в src → по индексу активной ветки', wantFile(TS_PROJECT + '/client/src/index.css'),
  { tool_name: 'Edit', tool_input: { file_path: TS_PROJECT + '/client/src/index.css' }, cwd: TS_PROJECT },
  { tool: 'edit', args: { filePath: TS_PROJECT + '/client/src/index.css' }, directory: TS_PROJECT });

both('edit конфига агента → allow', 'allow',
  { tool_name: 'Edit', tool_input: { file_path: '/home/enkeym/.claude/settings.json' }, cwd: TS_PROJECT },
  { tool: 'edit', args: { filePath: '/home/enkeym/.claude/settings.json' }, directory: TS_PROJECT });

both('edit исходника вне tokensave-проекта → allow', 'allow',
  { tool_name: 'Edit', tool_input: { file_path: NON_PROJECT + '/foo.ts' }, cwd: NON_PROJECT },
  { tool: 'edit', args: { filePath: NON_PROJECT + '/foo.ts' }, directory: NON_PROJECT });

// ---- ragsave: смысловой слой не должен попадать под гарды tokensave ----
// Гард — про подмену tokensave shell-командами. ragsave к этому отношения не
// имеет: он ничего не читает мимо индекса и сам является легитимным
// инструментом, поэтому его вызовы обязаны проходить.
bash('ragsave search → allow', 'allow', 'ragsave search "как настроен деплой"');
bash('ragsave init → allow', 'allow', 'ragsave init');
bash('ragsave sync с путём проекта → allow', 'allow', `ragsave sync ${TS_PROJECT}`);
bash('ragsave status в пайпе → allow', 'allow', 'ragsave status | jq .files');
bash('ragsave search с именем исходника в запросе → allow', 'allow',
  'ragsave search "что делает App.tsx"');

read('read индекса ragsave → allow', 'allow', TS_PROJECT + '/.ragsave/rag.db');
bash('чтение лога ragsave → allow', 'allow', 'cat .ragsave/sync.log');

// ---- отсутствие тупиков ----
// Главный риск гарда: запретить действие, не оставив рабочей альтернативы.
// Для всего, чего нет в индексе tokensave, должен оставаться прямой путь —
// иначе агент упирается и ищет обход. Проверяем обе двери сразу.
// Маска, которой в индексе активной ветки заведомо нет: состав индекса
// зависит от ветки, поэтому конкретное расширение выбираем, а не зашиваем.
const OUTSIDE_EXT = ['.lock', '.ini', '.cfg', '.yaml', '.yml', '.json']
  .find((e) => !EXTS.has(e)) || '.lock';

read('тупик №1: .env.example читается напрямую', 'allow', TS_PROJECT + '/.env.example');
bash(`тупик №2: маска вне индекса (*${OUTSIDE_EXT}) грепается напрямую`, 'allow',
  `grep -rn name --include=*${OUTSIDE_EXT} .`);
bash('тупик №3: вывод команд фильтруется грепом', 'allow', 'ls -la | grep src');
read('тупик №4: вендорный файл с индексируемым расширением читается напрямую', 'allow',
  TS_PROJECT + '/client/node_modules/storm-ui/dist/index.css');
bash('тупик №5: .env.example читается через shell', 'allow', 'cat .env.example');

// ---- предохранитель: повтор гасит отказ, латч класса — соседние цели ----
// Когда tokensave лёг (MCP на чужой ветке, лок БД), он лёг на весь граф, а не
// на один файл. Первый файл всё равно стоит отказ+повтор — так узнаём, что
// альтернативы нет; каждый следующий файл того же класса проходит сразу.
const decide = (sid, key, fam) => (breakerAllows(sid, key, fam) ? 'allow' : 'deny');
const SID = `test-breaker-${process.pid}-${Date.now()}`;

check('[core] breaker: первая цель → отказ держим', decide(SID, 'Read:/a/x.ts', 'read'), 'deny');
check('[core] breaker: повтор той же цели → пропуск', decide(SID, 'Read:/a/x.ts', 'read'), 'allow');
check('[core] breaker: соседняя цель того же класса → пропуск (латч)',
  decide(SID, 'Read:/a/y.ts', 'read'), 'allow');
check('[core] breaker: другой класс латчем read не задет',
  decide(SID, 'Edit:/a/z.ts', 'edit'), 'deny');
check('[core] breaker: без family латча нет — только точное совпадение',
  decide(SID, 'Bash:cat /a/q.ts', null), 'deny');
check('[core] breaker: свежая сессия — отказ как обычно',
  decide(`${SID}-other`, 'Read:/a/x.ts', 'read'), 'deny');

// Латч класса не должен продлеваться соседними целями: одна ранняя осечка не
// обязана отравлять всю сессию — окно живёт от реального повтора, не от каждого
// пропущенного чтения.
{
  const bf = BREAKER_FILE;
  const famKey = `${SID}|fam:read`;
  const t1 = JSON.parse(fs.readFileSync(bf, 'utf8'))[famKey]?.t;
  decide(SID, 'Read:/a/neighbor-1.ts', 'read'); // соседняя цель, не повтор
  decide(SID, 'Read:/a/neighbor-2.ts', 'read');
  const t2 = JSON.parse(fs.readFileSync(bf, 'utf8'))[famKey]?.t;
  check('[core] breaker: соседняя цель не двигает окно латча', t2 === t1 && !!t1, true);
}

// убрать за собой тестовые записи из общего файла предохранителя
try {
  const bf = BREAKER_FILE;
  const st = JSON.parse(fs.readFileSync(bf, 'utf8'));
  for (const k of Object.keys(st)) if (k.startsWith('test-breaker-')) delete st[k];
  fs.writeFileSync(bf, JSON.stringify(st));
} catch { /* файла нет — нечего чистить */ }

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
process.exit(fail ? 1 : 0);
