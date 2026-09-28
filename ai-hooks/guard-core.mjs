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
import { DatabaseSync } from 'node:sqlite';
import { segments, tokenize, commandName } from './shell-core.mjs';
import { statePath, readJSON, writeJSON, repoRoot } from './state-core.mjs';

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
// sed/awk без -i с файлом в аргументах читают его, как cat: `sed -n 1,120p
// file`. Поток из пайпа файла не называет и проходит.
const FILTER_CMDS = new Set(['sed', 'awk', 'gawk']);

// Интерпретаторы: путь прячется внутри строки кода, поэтому у них смотрим
// весь сегмент целиком, а не отдельные аргументы.
const EVAL_CMDS = new Set(['node', 'python', 'python3', 'ruby', 'perl', 'php', 'deno', 'bun']);
// Признак строки кода в аргументах или heredoc. Без него интерпретатор
// исполняет скрипт (`node test/test-guards.mjs`) — это запуск, как `tsc` или
// `eslint`, а не чтение.
const INLINE_CODE_RE = /^(-e|--eval|-p|--print|-c|-E|-r|eval)$|^--(eval|print)=/;
function runsInlineCode(toks, seg) {
  return toks.slice(1).some((t) => INLINE_CODE_RE.test(t)) || /<<-?\s*['"\\]?\w+/.test(seg);
}

// jq читает свой аргумент всегда. Данные вне индекса (логи хуков, отчёты)
// другим инструментом не разобрать: Read отдаст весь .jsonl целиком.
const JQ_DATA_RE = /\.jsonl?$/;

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
// heredoc — не перенаправление. Вывод команды в /tmp вне проекта — черновик,
// не правка. Проект — индекс tokensave или git вверх по дереву: клон
// чужой ветки в /tmp черновиком не считается.
function redirectTarget(seg, cwd) {
  const bare = seg.split('\n')[0].replace(/"[^"]*"|'[^']*'/g, '');
  const m = bare.match(/(?:^|[^=\-<>])>>?\s*([\w@.\-/\\]+)/);
  if (!m || m[1].startsWith('/dev/') || isScratch(cwd, m[1])) return null;
  return m[1];
}

const SCRATCH_DIRS = [...new Set(['/tmp', os.tmpdir()])].map((d) => path.resolve(d) + path.sep);

function isScratch(cwd, p) {
  const abs = path.resolve(cwd || process.cwd(), p);
  const dir = path.dirname(abs);
  return SCRATCH_DIRS.some((d) => abs.startsWith(d)) && !findRoot(dir) && !repoRoot(dir);
}

// Родной хук tokensave отказывает grep/rg/ag по коду в индексе и сам же
// печатает, как его снять: `TOKENSAVE_DISABLE_GREP_HOOK=1`. Агент этой
// подсказкой пользуется, а `git grep` хук не видит вовсе. Отказ гарда
// окончательный — оба обхода закрываем здесь, с отсылкой к тем же инструментам.
// Только форма присваивания: имя в тексте коммита или README — не обход.
const HOOK_OFF_RE = /\bTOKENSAVE_DISABLE_GREP_HOOK=/;

// Возвращает причину запрета или null. Любая неожиданность → null (fail-open).
// keepHeredoc: тело `node <<EOF … EOF` — часть сегмента интерпретатора, иначе
// путь внутри него распадался бы на безобидные строки.
export function guardBash(command, cwd, labels) {
  if (!command) return null;
  try {
    if (HOOK_OFF_RE.test(command)) return grepReason('снятие хука tokensave через `TOKENSAVE_DISABLE_GREP_HOOK`');

    for (const { text: seg } of segments(command, { keepHeredoc: true })) {
      const toks = tokenize(seg);
      const cmd = commandName(toks);

      if (cmd === 'git' && toks[1] === 'grep' && projectRoot(cwd)) {
        return grepReason('`git grep` в индексированном проекте');
      }

      const target = redirectTarget(seg, cwd);
      if (target) return editReason(target, fileTools(cwd, target, labels));

      // Черновик в /tmp вне проекта читается так же, как пишется: `> /tmp/x`
      // разрешён, значит и `tail /tmp/x`.
      const inPlace = INPLACE_CMDS.has(cmd) && toks.some((t) => /^-i/.test(t) || t === '--in-place');
      if (READ_CMDS.has(cmd) || (FILTER_CMDS.has(cmd) && !inPlace)) {
        const hit = [...pathCandidates(seg)].find((c) => isFile(cwd, c) && !isScratch(cwd, c));
        if (hit) return readReason(hit, fileTools(cwd, hit, labels));
      }

      if (WRITE_CMDS.has(cmd) || inPlace) {
        const hit = anyFile(seg, cwd);
        if (hit) return editReason(hit, fileTools(cwd, hit, labels));
      }

      if (EVAL_CMDS.has(cmd) && runsInlineCode(toks, seg)) {
        const hit = anyFile(seg, cwd);
        if (hit) return evalReason(hit, fileTools(cwd, hit, labels));
      }

      if (cmd === 'jq') {
        const hit = [...pathCandidates(seg)].find((c) => isFile(cwd, c) && !(JQ_DATA_RE.test(c) && !isIndexed(cwd, c)));
        if (hit) return evalReason(hit, fileTools(cwd, hit, labels));
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

// Файл из индекса: Read запрещён роутером чтения, а Edit без Read не работает —
// отказ сразу называет инструмент, который пройдёт.
const INDEX_TOOLS = { read: 'tokensave_read', edit: 'tokensave_str_replace' };

function fileTools(cwd, file, labels) {
  return isIndexed(cwd, file) ? INDEX_TOOLS : labels;
}

// ---------------------------------------------------------------------------
// Роутер чтения. Файл из индекса tokensave читают tokensave_body/tokensave_read,
// а не Read целиком: 300 строк ради одного символа — то, на чём растёт контекст
// (bin/tool-share.mjs). Правки не трогаем: Edit даёт дифф в чате, токены тянет
// чтение. Только таблица files, без проверки сервера и синка: индекс есть —
// значит, есть и инструмент.

// Пути в files — относительные от корня проекта, всегда через '/'.
function relKey(root, cwd, filePath) {
  const abs = path.resolve(cwd || process.cwd(), String(filePath));
  const rel = path.relative(root, abs);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return rel.split(path.sep).join('/');
}

function inIndex(root, key) {
  let db;
  try {
    db = new DatabaseSync(path.join(root, DB_REL), { readOnly: true });
    return !!db.prepare('SELECT 1 FROM files WHERE path = ?').get(key);
  } catch {
    return false; // БД занята или без таблицы — не запрещаем
  } finally {
    try { db?.close(); } catch { /* уже закрыта */ }
  }
}

// Файл есть в индексе tokensave? Нового файла там нет.
export function isIndexed(cwd, filePath) {
  if (!filePath || isHarnessConfigPath(filePath)) return false;
  const root = projectRoot(cwd, filePath);
  if (!root) return false;
  const key = relKey(root, cwd, filePath);
  return key ? inIndex(root, key) : false;
}

// Предохранитель: запрет полезен, пока у агента есть альтернатива. tokensave
// ответил ошибкой → агент повторяет Read той же цели и получает тот же отказ,
// в логах это семь одинаковых вызовов подряд. Повтор той же цели в окне
// пропускаем. Ошибка состояния → false: потерянная метка безопаснее
// пропущенного запрета.
const BREAKER_FILE = statePath('guard-breaker.json');
const BREAKER_WINDOW_MS = 3 * 60 * 1000;

export function breakerAllows(sessionId, key) {
  const id = `${sessionId || 'default'}|${key}`;
  const now = Date.now();
  const state = readJSON(BREAKER_FILE, {});
  for (const [k, v] of Object.entries(state)) {
    if (!v || typeof v.t !== 'number' || now - v.t > BREAKER_WINDOW_MS) delete state[k];
  }
  const open = Boolean(state[id]);
  state[id] = { t: state[id]?.t ?? now };
  writeJSON(BREAKER_FILE, state);
  return open;
}

export function guardRead(filePath, cwd, labels, sessionId) {
  if (!isIndexed(cwd, filePath)) return null;
  if (breakerAllows(sessionId, `Read:${path.resolve(cwd || process.cwd(), String(filePath))}`)) return null;
  return (
    `Файл в индексе tokensave. Вместо ${labels.read}: tokensave_body / tokensave_signature (символ), ` +
    'tokensave_read (файл; диапазон — `mode: "lines", lines: "A-B"`, без `mode` придёт весь файл), tokensave_context (обзор). ' +
    `tokensave ответил ошибкой или пусто — процитируй ответ и повтори ${labels.read}: ` +
    'повтор той же цели в течение 3 минут проходит.'
  );
}

function editReason(file, labels) {
  return `Файл \`${file}\` через shell не правят — ${labels.edit}.`;
}

function grepReason(what) {
  return `${what} — обход хука tokensave, отказ окончательный. Символ: tokensave_search / `
    + 'tokensave_signature_search; использования: tokensave_callers; текст: tokensave_search с literal: true; '
    + 'доки, конфиги, yml: rag_search.';
}

function evalReason(file, labels) {
  return `Файл \`${file}\` через интерпретатор не читают и не правят — ${labels.read} / ${labels.edit}.`;
}
