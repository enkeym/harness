// Общая логика shell-гарда — единая точка истины для Claude Code и OpenCode.
// Модуль чистый: не читает stdin, не пишет stdout, не знает про формат хуков.
// Возвращает причину запрета (string) или null.
//
// Правило одно: shell запускает команды, а файлы читает Read и правит Edit.
// `cat file`, `sed -i`, `node -e "fs.writeFileSync(…)"`, `> file` делают то же,
// что встроенные инструменты, но мимо их проверок и без диффа в чате.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { segments, tokenize, commandName } from './shell-core.mjs';

const HOME = process.env.HOME || os.homedir();
const DB_REL = path.join('.tokensave', 'tokensave.db');

// Конфиг/тулинг самих агентов (.claude/…, .opencode/…, ~/.config/opencode/…,
// ~/.ai-hooks/…) — project-bootstrap не считает такие каталоги проектом.
const HARNESS_CONFIG_RE =
  /(^|[\\/])(\.claude|\.opencode|\.ai-hooks)([\\/]|$)|[\\/]\.config[\\/]opencode([\\/]|$)/;

export function isHarnessConfigPath(p) {
  return HARNESS_CONFIG_RE.test(String(p || ''));
}

// Корень tokensave-проекта: ближайший каталог вверх по дереву с БД.
// $HOME не считается: ~/.tokensave существует всегда (global.db + config.toml),
// иначе весь домашний каталог был бы «проектом».
function findRoot(startDir) {
  let dir = startDir;
  while (dir) {
    if (fs.existsSync(path.join(dir, DB_REL))) {
      return path.resolve(dir) === path.resolve(HOME) ? null : dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}

export function projectRoot(cwd, filePath) {
  const base = cwd ? path.resolve(cwd) : process.cwd();
  if (filePath) {
    // Каталог — начинаем поиск с него самого, файл — с его каталога: для `.`
    // dirname дал бы родителя, и корень искался бы на уровень выше проекта.
    const abs = path.resolve(base, String(filePath));
    let start;
    try {
      start = fs.statSync(abs).isDirectory() ? abs : path.dirname(abs);
    } catch {
      start = path.dirname(abs); // не существует — считаем файлом
    }
    const fromFile = findRoot(start);
    if (fromFile) return fromFile;
  }
  return findRoot(base);
}

// Имена инструментов различаются между агентами — подставляем их в текст
// запрета, чтобы он указывал на реально доступный инструмент.
export const CLAUDE_LABELS = { read: 'Read', edit: 'Edit/Write' };
export const OPENCODE_LABELS = { read: 'read', edit: 'edit/write' };

// ---------------------------------------------------------------------------
// Разбор нарочно грубый — не парсер shell, а распознавание форм. Всё, что не
// распозналось, проходит: лучше пропустить обход, чем заблокировать `git`,
// `tsc`, `eslint` над теми же путями (они читают файл легитимно).

// Команды, которые читают содержимое файла.
const READ_CMDS = new Set([
  'cat', 'head', 'tail', 'less', 'more', 'bat', 'nl', 'tac', 'rev',
  'od', 'xxd', 'strings',
]);

// Команды, которые пишут в файл на месте. sed/perl/awk — только с -i.
const WRITE_CMDS = new Set(['tee', 'dd', 'truncate', 'install']);
const INPLACE_CMDS = new Set(['sed', 'perl', 'awk', 'gawk']);

// Интерпретаторы: путь прячется внутри строки кода, поэтому у них смотрим
// весь сегмент целиком, а не отдельные аргументы.
const EVAL_CMDS = new Set(['node', 'python', 'python3', 'ruby', 'perl', 'php', 'deno', 'bun', 'jq']);
// Признак строки кода в аргументах или heredoc. Без него интерпретатор
// исполняет скрипт (`node test/test-guards.mjs`) — это запуск, как `tsc` или
// `eslint`, а не чтение. jq всегда читает свой аргумент.
const INLINE_CODE_RE = /^(-e|--eval|-p|--print|-c|-E|-r|eval)$|^--(eval|print)=/;
function runsInlineCode(cmd, toks, seg) {
  if (cmd === 'jq') return true;
  return toks.slice(1).some((t) => INLINE_CODE_RE.test(t)) || /<<-?\s*['"\\]?\w+/.test(seg);
}

// Кандидаты в пути: всё, что похоже на файл с расширением. Ловит и голые
// аргументы, и пути внутри строк кода — поэтому применяется к сырому сегменту.
function pathCandidates(text) {
  return new Set(String(text).match(/[\w@.\-/\\]*\.\w+/g) || []);
}

function isFile(cwd, p) {
  try {
    return fs.statSync(path.resolve(cwd || process.cwd(), p)).isFile();
  } catch {
    return false;
  }
}

function anyFile(text, cwd) {
  for (const c of pathCandidates(text)) if (isFile(cwd, c)) return c;
  return null;
}

// Перенаправление пишет в файл, даже новый; /dev/null и прочие устройства — нет.
// Смотрим первую строку без кавычек: `=>` и `->` в строке кода или теле
// heredoc — не перенаправление.
function redirectTarget(seg) {
  const bare = seg.split('\n')[0].replace(/"[^"]*"|'[^']*'/g, '');
  const m = bare.match(/(?:^|[^=\-<>])>>?\s*([\w@.\-/\\]+)/);
  if (!m || m[1].startsWith('/dev/')) return null;
  return m[1];
}

// Возвращает причину запрета или null. Любая неожиданность → null (fail-open).
// keepHeredoc: тело `node <<EOF … EOF` — часть сегмента интерпретатора, иначе
// путь внутри него распадался бы на безобидные строки.
export function guardBash(command, cwd, labels) {
  if (!command) return null;
  try {
    for (const { text: seg } of segments(command, { keepHeredoc: true })) {
      const toks = tokenize(seg);
      const cmd = commandName(toks);

      const target = redirectTarget(seg);
      if (target) return editReason(target, labels);

      if (READ_CMDS.has(cmd)) {
        const hit = anyFile(seg, cwd);
        if (hit) return readReason(hit, labels);
      }

      if (WRITE_CMDS.has(cmd) || (INPLACE_CMDS.has(cmd) && toks.some((t) => /^-i/.test(t) || t === '--in-place'))) {
        const hit = anyFile(seg, cwd);
        if (hit) return editReason(hit, labels);
      }

      if (EVAL_CMDS.has(cmd) && runsInlineCode(cmd, toks, seg)) {
        const hit = anyFile(seg, cwd);
        if (hit) return evalReason(hit, labels);
      }
    }
  } catch {
    return null;
  }
  return null;
}

// mcp__ide__executeCode — исполнение кода в Jupyter-ядре. Канал мимо Bash,
// но результат тот же, поэтому и правило то же.
export function guardExec(code, cwd, labels) {
  if (!code) return null;
  try {
    const hit = anyFile(code, cwd);
    return hit ? evalReason(hit, labels) : null;
  } catch {
    return null;
  }
}

function readReason(file, labels) {
  return `Файл \`${file}\` через shell не читают — ${labels.read}.`;
}

function editReason(file, labels) {
  return `Файл \`${file}\` через shell не правят — ${labels.edit}.`;
}

function evalReason(file, labels) {
  return `Файл \`${file}\` через интерпретатор не читают и не правят — ${labels.read} / ${labels.edit}.`;
}
