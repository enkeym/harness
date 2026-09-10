// Ask mode — общее ядро. Режим «только ответ в чате»: агент читает, ищет,
// объясняет, показывает правку текстом, но ничего не меняет.
//
// Встроенные режимы Claude Code (manual/accept edits/plan/auto) заданы в самом
// бинаре и не расширяются конфигом, поэтому ask mode собран из того, что
// harness отдаёт наружу: состояние в файле, PreToolUse-гард на изменяющие
// инструменты, подсказка в промпт и индикатор в statusline.
//
// Ключ состояния — рабочий каталог, а не сессия: слэш-команда, хук и statusline
// видят cwd одинаково, а session_id из них знают не все. Практическое следствие:
// две сессии в одном каталоге делят режим.
//
// Режим по умолчанию (файл default) действует там, где каталог ничего не сказал
// о себе, то есть в каждой новой сессии. Каталог всегда пишет состояние явно —
// «файла нет» больше не значит «выключено», иначе /ask-off не смог бы отменить
// включённый по умолчанию режим.

import fs from 'node:fs';
import path from 'node:path';
import { STATE_ROOT, projectKey, repoRootOr } from './state-core.mjs';

const STATE_DIR = path.join(STATE_ROOT, 'ask-mode');
const DEFAULT_FILE = path.join(STATE_DIR, 'default');
// Файла `default` нет или он не читается — режим выключен. Ask mode не средство
// защиты (за это отвечает security-guard), а удобство, поэтому отказ его
// хранилища обязан ронять режим в «выключено». Обратный fallback означал бы
// молча включённый ask mode во всех каталогах сразу, при этом statusline и
// `ask-mode.mjs status` читают тот же файл и показали бы то же «включён» —
// то есть симптом «правки запрещены без причины» без единого следа причины.
const FALLBACK_DEFAULT = false;

// Каталог, к которому привязан режим. Не буквальный cwd: рабочий каталог
// сессии дрейфует (`cd` внутри Bash сдвигает его на весь остаток сессии), и
// стоило агенту зайти в соседний репозиторий, как statusline читал режим одного
// каталога, а PreToolUse-гард — другого. Отсюда «в статусбаре off, а правки
// запрещены». CLAUDE_PROJECT_DIR — корень сессии, он не дрейфует; там, где его
// нет, остаётся cwd, как было.
export function anchorDir(cwd) {
  return process.env.CLAUDE_PROJECT_DIR || cwd;
}

// Ключ — корень проекта (projectKey из state-core): внутри одного репозитория
// подкаталоги делят режим.
function keyFor(cwd) {
  return `dir-${projectKey(anchorDir(cwd))}`;
}

function read(file) {
  try {
    return fs.readFileSync(file, 'utf8').trim().split('\n')[0];
  } catch {
    return null;
  }
}

function write(file, value) {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.writeFileSync(file, `${value}\n`);
}

export function defaultOn() {
  const v = read(DEFAULT_FILE);
  return v === null ? FALLBACK_DEFAULT : v === 'on';
}

export function setDefault(on) {
  write(DEFAULT_FILE, on ? 'on' : 'off');
  return on;
}

// Откуда взято состояние — нужно statusline и команде status. dir возвращаем
// явно: когда statusline и гард всё же разойдутся, вопрос «к какому каталогу
// привязан режим» должен иметь ответ, а не догадку.
export function state(cwd) {
  const dir = repoRootOr(anchorDir(cwd));
  const v = read(path.join(STATE_DIR, keyFor(cwd)));
  if (v === 'on' || v === 'off') return { on: v === 'on', source: 'каталог', dir };
  return { on: defaultOn(), source: 'по умолчанию', dir };
}

export function isOn(cwd) {
  return state(cwd).on;
}

export function setMode(cwd, on) {
  write(path.join(STATE_DIR, keyFor(cwd)), on ? 'on' : 'off');
  return on;
}

// Снять решение каталога и вернуться к режиму по умолчанию.
export function resetMode(cwd) {
  try { fs.unlinkSync(path.join(STATE_DIR, keyFor(cwd))); } catch { /* уже сброшен */ }
  return defaultOn();
}

// ---------------------------------------------------------------------------
// Что считается изменением. Список закрытый: всё, чего в нём нет, разрешено —
// ask mode ограничивает запись, а не работу.

const WRITE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

const TOKENSAVE_WRITE_RE =
  /tokensave_(str_replace|multi_str_replace|replace_symbol|insert_at|insert_at_symbol)$/;

// Артефакт — публикация наружу, а не ответ в чате.
const ARTIFACT_WRITE_ACTIONS = new Set([
  'publish', 'reply', 'resolve', 'upload_asset', 'delete_asset', 'watch', 'resume_replies',
]);

// Встроенные субагенты, которым нечем менять файлы. Остальные типы в ask mode
// запрещены: запрет, который обходится через субагента, — не запрет. Своих
// ролевых агентов в харнесе нет — только скиллы.
const READONLY_AGENTS = new Set([
  'Explore', 'Plan', 'claude-code-guide', 'statusline-setup',
]);

// Команды, которые меняют состояние всегда.
const MUTATING_CMDS = new Set([
  'rm', 'rmdir', 'mv', 'cp', 'mkdir', 'touch', 'ln', 'chmod', 'chown', 'chgrp',
  'truncate', 'tee', 'dd', 'shred', 'install', 'patch', 'unzip', 'tar',
]);

// Команды, у которых меняет состояние только часть подкоманд.
const MUTATING_SUBCMDS = {
  git: new Set(['add', 'commit', 'push', 'checkout', 'switch', 'reset', 'revert', 'merge',
    'rebase', 'apply', 'stash', 'cherry-pick', 'clean', 'rm', 'mv', 'tag', 'restore', 'init']),
  npm: new Set(['i', 'install', 'ci', 'add', 'remove', 'rm', 'uninstall', 'link', 'publish', 'update', 'upgrade']),
  pnpm: new Set(['i', 'install', 'add', 'remove', 'rm', 'link', 'publish', 'update', 'up']),
  yarn: new Set(['install', 'add', 'remove', 'link', 'publish', 'upgrade']),
  bun: new Set(['install', 'add', 'remove', 'link', 'publish', 'update']),
  pip: new Set(['install', 'uninstall']),
  pip3: new Set(['install', 'uninstall']),
  cargo: new Set(['install', 'add', 'remove', 'publish', 'fix']),
  go: new Set(['install', 'get', 'mod']),
  apt: new Set(['install', 'remove', 'purge', 'upgrade']),
  'apt-get': new Set(['install', 'remove', 'purge', 'upgrade']),
  dpkg: new Set(['-i', '--install', '-r', '--remove']),
  docker: new Set(['run', 'start', 'stop', 'rm', 'rmi', 'exec', 'build', 'push', 'prune', 'kill', 'restart', 'compose']),
  'docker-compose': new Set(['up', 'down', 'restart', 'build', 'rm']),
  kubectl: new Set(['apply', 'delete', 'create', 'patch', 'scale', 'rollout', 'edit', 'exec']),
  systemctl: new Set(['start', 'stop', 'restart', 'reload', 'enable', 'disable', 'mask', 'unmask']),
  service: new Set(['start', 'stop', 'restart', 'reload']),
  opencode: new Set(['run']),
};

const INPLACE_CMDS = new Set(['sed', 'perl', 'awk', 'gawk']);
const EVAL_CMDS = new Set(['node', 'python', 'python3', 'ruby', 'deno', 'bun', 'php']);

// Однострочник интерпретатора запрещаем не за сам факт `-e`/`-c`, а за запись:
// `python3 -c "json.load(...)"` — обычное чтение, и блокировать его значит
// толкать в обход там, где ask mode ничего не защищает.
// Без закрывающей \b: writeFileSync, mkdirSync, rmSync — те же имена с суффиксом.
// У open() смотрим именно режим вторым аргументом: open('a.json') — это чтение.
const EVAL_WRITE_RE =
  /\b(writeFile|appendFile|createWriteStream|unlink|rmdir|rmSync|mkdir|rename|copyFile|chmod|chown|truncate|rmtree|makedirs|savefig|to_csv|to_json|execSync|spawnSync|popen|subprocess)|open\s*\([^)]*,\s*['"][rbt+]*[wax]/;

// Перенаправление в файл. Дескрипторы (`2>&1`) и /dev/null не в счёт.
const REDIRECT_RE = /(?<![0-9&])>>?\s*(?!&|\/dev\/(?:null|stdout|stderr))[\w./~$-]/;

// Управление самим режимом через shell должно проходить всегда, иначе из
// ask mode нельзя выйти командой.
const SELF_RE = /ask-mode\.mjs/;

function commandName(tokens) {
  let i = 0;
  while (i < tokens.length &&
    (/^[A-Za-z_]\w*=/.test(tokens[i]) || ['sudo', 'env', 'command', 'nohup', 'time', 'setsid'].includes(tokens[i]))) i++;
  return path.basename(tokens[i] || '');
}

function firstArg(tokens, cmd) {
  const start = tokens.findIndex((t) => path.basename(t) === cmd);
  for (let i = start + 1; i < tokens.length; i++) {
    if (!tokens[i].startsWith('-') || MUTATING_SUBCMDS[cmd]?.has(tokens[i])) return tokens[i];
  }
  return '';
}

// Разбиение по операторам shell с учётом кавычек: `node -e "a; write(…)"` —
// одна команда, а не две, и разрыв по `;` внутри строки прятал бы запись.
function segments(text) {
  const out = [];
  let buf = '';
  let quote = null;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      buf += c;
      if (c === quote && text[i - 1] !== '\\') quote = null;
      continue;
    }
    if (c === '"' || c === "'") { quote = c; buf += c; continue; }
    if (c === ';' || c === '\n' || (c === '|' || c === '&') && (text[i + 1] === c || c === '|')) {
      if (text[i + 1] === c) i++;
      out.push(buf);
      buf = '';
      continue;
    }
    buf += c;
  }
  out.push(buf);
  return out;
}

export function bashMutates(command) {
  const text = String(command || '');
  if (!text.trim() || SELF_RE.test(text)) return false;

  for (const segment of segments(text)) {
    const seg = segment.trim();
    if (!seg) continue;
    if (REDIRECT_RE.test(seg)) return true;

    const tokens = [...seg.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)].map((m) => m[1] ?? m[2] ?? m[3]);
    const cmd = commandName(tokens);
    if (!cmd) continue;

    if (MUTATING_CMDS.has(cmd)) return true;
    if (INPLACE_CMDS.has(cmd) && tokens.some((t) => /^-i/.test(t) || t === '--in-place')) return true;
    if (EVAL_CMDS.has(cmd)
      && tokens.some((t) => t === '-e' || t === '-c' || t === '--eval')
      && EVAL_WRITE_RE.test(seg)) return true;
    if (MUTATING_SUBCMDS[cmd]?.has(firstArg(tokens, cmd))) return true;
  }
  return false;
}

// Причина запрета или null, если инструмент ничего не меняет.
export function askGuard(toolName, toolInput = {}) {
  const name = String(toolName || '');
  const ti = toolInput || {};

  if (WRITE_TOOLS.has(name) || TOKENSAVE_WRITE_RE.test(name)) {
    return `правка файлов (${name})`;
  }
  if (name === 'Bash' || name === 'mcp__ide__executeCode') {
    const payload = name === 'Bash' ? ti.command : ti.code;
    return bashMutates(payload) ? 'команда меняет состояние' : null;
  }
  if (name === 'Artifact' && ARTIFACT_WRITE_ACTIONS.has(ti.action || 'publish')) {
    return 'публикация артефакта';
  }
  if (name === 'Agent' && !READONLY_AGENTS.has(ti.subagent_type || '')) {
    return `субагент «${ti.subagent_type || 'general-purpose'}» может менять файлы`;
  }
  return null;
}

export const ASK_DENY_HINT =
  'Ask mode: изменения выключены — отвечай в чате. Правку показывай текстом или диффом, ' +
  'не применяя её. Команды, меняющие состояние (установка, git write, деплой), тоже не запускай; ' +
  'читать, искать и запускать тесты можно. Выключить режим: /ask-off.';
