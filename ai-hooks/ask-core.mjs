// Ask mode — общее ядро. Режим «только ответ в чате»: агент читает, ищет,
// объясняет, показывает правку текстом, но ничего не меняет.
//
// Встроенные режимы Claude Code (manual/accept edits/plan/auto) заданы в самом
// бинаре и не расширяются конфигом, поэтому ask mode собран из того, что
// harness отдаёт наружу: состояние в файле, PreToolUse-гард на изменяющие
// инструменты, подсказка в промпт и индикатор в statusline.
//
// Ключ состояния — сессия: хуки и statusline получают session_id во входном
// JSON, `/ask` и `!node … ask-mode.mjs` — из CLAUDE_CODE_SESSION_ID. Раньше
// ключом был каталог, а сброс на SessionStart — способом начать новую сессию с
// умолчания; вторая сессия в том же каталоге этим сбросом молча выключала
// /ask в первой, уже работающей. Без session_id (запуск из терминала вне
// Claude Code) ключ — каталог.
//
// Режим по умолчанию (файл default) действует там, где сессия ничего не сказала
// о себе, то есть в каждой новой. Сессия всегда пишет состояние явно —
// «файла нет» не значит «выключено», иначе /ask-off не смог бы отменить
// включённый по умолчанию режим.

import fs from 'node:fs';
import path from 'node:path';
import { STATE_ROOT, projectKey, repoRootOr } from './state-core.mjs';
import { segments, tokenize, commandIndex, gitSubcommandAt, dropConditionals, baseCommand } from './shell-core.mjs';

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

// Ключ — сессия; без неё корень проекта (projectKey из state-core): внутри
// одного репозитория подкаталоги делят режим.
function keyFor(cwd, sid) {
  if (sid) return `sess-${String(sid).replace(/[^\w-]/g, '_')}`;
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

// Откуда взято состояние — нужно команде status. Якорь возвращаем явно: когда
// statusline и гард всё же разойдутся, вопрос «к какой сессии или каталогу
// привязан режим» должен иметь ответ, а не догадку.
export function state(cwd, sid) {
  const anchor = sid ? `сессия ${sid}` : repoRootOr(anchorDir(cwd));
  const v = read(path.join(STATE_DIR, keyFor(cwd, sid)));
  if (v === 'on' || v === 'off') return { on: v === 'on', source: sid ? 'сессия' : 'каталог', anchor };
  return { on: defaultOn(), source: 'по умолчанию', anchor };
}

export function isOn(cwd, sid) {
  return state(cwd, sid).on;
}

export function setMode(cwd, on, sid) {
  write(path.join(STATE_DIR, keyFor(cwd, sid)), on ? 'on' : 'off');
  return on;
}

// Снять решение сессии (каталога) и вернуться к режиму по умолчанию.
export function resetMode(cwd, sid) {
  try { fs.unlinkSync(path.join(STATE_DIR, keyFor(cwd, sid))); } catch { /* уже сброшен */ }
  return defaultOn();
}

// ---------------------------------------------------------------------------
// Что считается изменением. Список закрытый: всё, чего в нём нет, разрешено —
// ask mode ограничивает запись, а не работу.

const WRITE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

// Правящие инструменты tokensave (`tokensave_more` area edit). `rename` без
// `dry_run: false` только показывает план и дифф — это чтение.
const TOKENSAVE_WRITE_RE =
  /tokensave_(str_replace|multi_str_replace|replace_symbol|replace_lines|insert_at|insert_at_symbol|delete_symbol)$/;
const TOKENSAVE_RENAME_RE = /tokensave_rename$/;

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
  'truncate', 'tee', 'dd', 'shred', 'install', 'patch', 'unzip', 'tar', 'rsync', 'unlink',
  // Редакторы: из Bash они работают только скриптом (`ed -s`, `vim -es`), а скрипт правит.
  'ed', 'ex', 'vim', 'vi', 'nvim',
]);

// Команды, у которых меняет состояние только часть подкоманд.
const MUTATING_SUBCMDS = {
  git: new Set(['add', 'commit', 'push', 'checkout', 'switch', 'reset', 'revert', 'merge',
    'rebase', 'apply', 'stash', 'cherry-pick', 'clean', 'rm', 'mv', 'tag', 'restore', 'init',
    'pull', 'am', 'update-ref', 'commit-tree']),
  npm: new Set(['i', 'install', 'ci', 'add', 'remove', 'rm', 'uninstall', 'link', 'publish', 'update', 'upgrade', 'version']),
  pnpm: new Set(['i', 'install', 'add', 'remove', 'rm', 'link', 'publish', 'update', 'up', 'version']),
  yarn: new Set(['install', 'add', 'remove', 'link', 'publish', 'upgrade', 'version']),
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
// Буквы со значением в связке коротких флагов: после них остаток слова — значение
// (`perl -Mlib`), а не `-i`. У awk связок нет: `-i inplace`.
const INPLACE_VALUE_FLAGS = { sed: 'efl', perl: 'eEMmIxFCdD' };
const EVAL_CMDS = new Set(['node', 'python', 'python3', 'ruby', 'deno', 'bun', 'php', 'tsx', 'ts-node']);
const EVAL_INLINE = new Set(['-e', '-c', '--eval', '-p', '--print']);
const HEREDOC_RE = /<<-?\s*['"\\]?\w+/;

// Однострочник интерпретатора запрещаем не за сам факт `-e`/`-c`, а за запись:
// `python3 -c "json.load(...)"` — обычное чтение, и блокировать его значит
// толкать в обход там, где ask mode ничего не защищает.
// Без закрывающей \b: writeFileSync, mkdirSync, rmSync — те же имена с суффиксом.
// У open() смотрим именно режим вторым аргументом: open('a.json') — это чтение.
const EVAL_WRITE_RE =
  /\b(writeFile|appendFile|createWriteStream|unlink|rmdir|rmSync|mkdir|rename|copyFile|chmod|chown|truncate|rmtree|makedirs|savefig|to_csv|to_json|execSync|spawnSync|popen|subprocess|write_text|write_bytes|os\.remove|os\.replace|shutil\.(move|copy))|open\s*\([^)]*,\s*['"][rbt+]*[wax]/;

// Перенаправление в файл. Дескрипторы (`2>&1`) и /dev/null не в счёт.
const REDIRECT_RE = /(?<![0-9&])>>?\s*(?!&|\/dev\/(?:null|stdout|stderr))[\w./~$-]/;

// Управление самим режимом через shell должно проходить всегда, иначе из
// ask mode нельзя выйти командой. Но только когда команда сегмента — сам
// скрипт: упоминание имени (`rm -rf src; echo ask-mode.mjs`) ничего не даёт.
const SELF_RE = /(^|\/)ask-mode\.mjs$/;

// Оболочки и eval: запись прячется в строке, её разбираем как команду.
const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash']);
const FIND_EXEC = new Set(['-exec', '-execdir', '-ok', '-okdir']);

// Форматтеры и линтеры переписывают файлы только с флагом записи.
const FORMATTERS = new Set(['prettier', 'eslint', 'stylelint', 'biome', 'ruff']);
const FORMAT_WRITE_FLAGS = new Set(['--write', '-w', '--fix']);

// `git branch` без флагов списка и со свободным аргументом создаёт ветку;
// удаление, переименование и копирование — флагами.
const BRANCH_WRITE_RE = /^(-[a-zA-Z]*[dDmMcCf][a-zA-Z]*|--(delete|move|copy|force|set-upstream-to.*|unset-upstream|edit-description))$/;
const BRANCH_LIST_FLAGS = new Set(['-l', '--list', '-a', '--all', '-r', '--remotes', '--contains', '--no-contains',
  '--merged', '--no-merged', '--points-at', '--show-current', '-v', '-vv', '--verbose', '--format', '--sort']);

function isSelf(tokens, at) {
  const cmd = path.basename(tokens[at] || '');
  if (SELF_RE.test(cmd)) return true;
  return EVAL_CMDS.has(cmd) && SELF_RE.test(tokens.slice(at + 1).find((t) => !t.startsWith('-')) || '');
}

function firstArg(tokens, at) {
  const cmd = path.basename(tokens[at]);
  for (let i = at + 1; i < tokens.length; i++) {
    if (!tokens[i].startsWith('-') || MUTATING_SUBCMDS[cmd]?.has(tokens[i])) return tokens[i];
  }
  return '';
}

function gitMutates(tokens) {
  const at = gitSubcommandAt(tokens);
  const sub = tokens[at];
  const args = tokens.slice(at + 1);
  if (sub === 'worktree') return !['list', undefined].includes(args.find((t) => !t.startsWith('-')));
  if (sub !== 'branch') return MUTATING_SUBCMDS.git.has(sub);
  if (args.some((t) => BRANCH_WRITE_RE.test(t))) return true;
  return !args.some((t) => BRANCH_LIST_FLAGS.has(t)) && args.some((t) => !t.startsWith('-'));
}

// Команды, которые запускает сама команда: `bash -c "…"`, `bash <<EOF`, `eval "…"`,
// `find … -exec rm {} \;`.
function nested(tokens, at, body) {
  const cmd = path.basename(tokens[at]);
  const rest = tokens.slice(at + 1);
  if (SHELLS.has(cmd)) {
    const c = rest.findIndex((t) => /^-[a-z]*c[a-z]*$/.test(t));
    if (c !== -1) return rest[c + 1] ? [rest[c + 1]] : [];
    return body ? [body] : [];
  }
  if (cmd === 'eval') return [rest.join(' ')];
  if (cmd === 'find') {
    const out = [];
    for (let i = 0; i < rest.length; i++) {
      if (!FIND_EXEC.has(rest[i])) continue;
      const end = rest.findIndex((t, j) => j > i && [';', '\\;', '+'].includes(t));
      out.push(rest.slice(i + 1, end === -1 ? undefined : end).join(' '));
    }
    return out;
  }
  return [];
}

// `sed -i`, `perl -pi`, `sed -Ei`, `--in-place`, gawk `-i inplace`.
function inPlace(cmd, tokens) {
  return tokens.some((t) => {
    if (t === '--in-place' || t.startsWith('--in-place=')) return true;
    if (!INPLACE_VALUE_FLAGS[cmd]) return /^-i/.test(t);
    if (!/^-[^-]/.test(t)) return false;
    for (const c of t.slice(1)) {
      if (c === 'i') return true;
      if (INPLACE_VALUE_FLAGS[cmd].includes(c)) return false;
    }
    return false;
  });
}

// Разбор shell — общий с гардом безопасности (shell-core): `&`, `( … )`,
// `$(…)`, обёртки с опциями (`sudo -u app`). Кавычки учтены: `node -e "a;
// write(…)"` — одна команда, а не две. Тело heredoc остаётся со своей командой
// (keepHeredoc): `python3 - <<EOF` с записью в теле — тот же однострочник, а `=>`
// в теле — не перенаправление. Флаги и перенаправления — по первой строке.
export function bashMutates(command, depth = 0) {
  const text = String(command || '');
  if (!text.trim() || depth > 3) return false;

  for (const { text: seg } of segments(text, { keepHeredoc: true })) {
    const nl = seg.indexOf('\n');
    const head = nl === -1 ? seg : seg.slice(0, nl);
    const body = nl !== -1 && HEREDOC_RE.test(head) ? seg.slice(nl + 1) : null;
    const tokens = tokenize(head);
    const at = commandIndex(tokens);
    const cmd = baseCommand(path.basename(tokens[at] || ''));
    if (REDIRECT_RE.test(dropConditionals(head))) return true;
    if (!cmd || isSelf(tokens, at)) continue;

    if (MUTATING_CMDS.has(cmd)) return true;
    if (cmd === 'find' && tokens.includes('-delete')) return true;
    if (nested(tokens, at, body).some((inner) => bashMutates(inner, depth + 1))) return true;
    if (INPLACE_CMDS.has(cmd) && inPlace(cmd, tokens)) return true;
    if (EVAL_CMDS.has(cmd)
      && (body !== null || tokens.some((t) => EVAL_INLINE.has(t)))
      && EVAL_WRITE_RE.test(seg)) return true;
    if (tokens.some((t) => FORMATTERS.has(path.basename(t))) && tokens.some((t) => FORMAT_WRITE_FLAGS.has(t))) return true;
    if (cmd === 'git') {
      if (gitMutates(tokens)) return true;
    } else if (MUTATING_SUBCMDS[cmd]?.has(firstArg(tokens, at))) return true;
  }
  return false;
}

// Причина запрета или null, если инструмент ничего не меняет.
export function askGuard(toolName, toolInput = {}) {
  const name = String(toolName || '');
  const ti = toolInput || {};

  if (WRITE_TOOLS.has(name) || TOKENSAVE_WRITE_RE.test(name) || (TOKENSAVE_RENAME_RE.test(name) && ti.dry_run === false)) {
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
