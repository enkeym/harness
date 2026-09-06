// Гард безопасности — общее ядро. Отвечает на один вопрос: этот вызов может
// утечь секретом, выгрузить данные, тронуть прод или отправить что-то наружу?
//
// Два уровня ответа, и разница принципиальна:
//   deny — законной причины нет, и есть безопасная альтернатива (секреты);
//   ask  — операция законная, но нужен человек (дамп БД, push в main, curl
//          с телом). В auto mode это единственное, что вернёт подтверждение.
//
// Предохранителя (breaker) здесь нет намеренно: в гардах tokensave он
// пропускает повторный вызов, потому что там запрет — про выбор инструмента.
// Здесь запрет про последствия, и «со второй попытки можно» его отменяет.
//
// Разбор нарочно грубый — распознаются формы, а не синтаксис shell. Всё
// нераспознанное проходит: задача не поймать любой обход, а закрыть удобный
// путь и поставить человека там, где цена ошибки высока.

import path from 'node:path';

export const DENY = 'deny';
export const ASK = 'ask';

// ---------------------------------------------------------------------------
// Секреты. Файл считается хранилищем секретов по имени: содержимое читать,
// чтобы решить, читать ли содержимое, — бессмысленно.

const SECRET_FILE_RE = [
  /(^|[\\/])\.env(\.[\w-]+)*$/i,
  /(^|[\\/])\.?(npmrc|pypirc|netrc)$/i,
  /(^|[\\/])id_(rsa|dsa|ecdsa|ed25519)$/,
  /(^|[\\/])(credentials|auth|secrets?|service-account[\w-]*)\.json$/i,
  /(^|[\\/])\.git-credentials$/,
  /\.(pem|p12|pfx|keystore|jks)$/i,
  /(^|[\\/])[\w.-]*(private|secret)[\w.-]*\.key$/i,
];

// Примеры и шаблоны — не секреты, в них имена переменных без значений.
const SECRET_EXEMPT_RE = /\.(example|sample|template|dist|tpl)$|(^|[\\/])\.env\.example$/i;

export function isSecretPath(p) {
  const s = String(p || '');
  if (!s || SECRET_EXEMPT_RE.test(s)) return false;
  return SECRET_FILE_RE.some((re) => re.test(s));
}

// Значение, похожее на живой секрет, внутри произвольного текста. Нужно для
// делегирования: промпт уходит внешнему провайдеру, и туда не должно попасть
// ничего из этого списка. Проверяем формы известных токенов, а не энтропию —
// энтропийный порог ловит хеши коммитов и base64 картинок.
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
// Shell. Сегменты режем так же, как в guard-core: по операторам, с учётом
// кавычек, чтобы `git push` внутри строки не считался отдельной командой.

function segments(command) {
  const out = [];
  let buf = '';
  let quote = null;
  const text = String(command || '');
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      buf += c;
      if (c === quote && text[i - 1] !== '\\') quote = null;
      continue;
    }
    if (c === '"' || c === "'") { quote = c; buf += c; continue; }
    if (c === ';' || c === '\n' || c === '|' || (c === '&' && text[i + 1] === '&')) {
      if (c === '&') i++;
      out.push(buf); buf = ''; continue;
    }
    buf += c;
  }
  out.push(buf);
  return out.map((s) => s.trim()).filter(Boolean);
}

function tokenize(seg) {
  return [...String(seg).matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)].map((m) => m[1] ?? m[2] ?? m[3]);
}

function commandName(toks) {
  let i = 0;
  const wrappers = ['sudo', 'env', 'command', 'nohup', 'time', 'setsid', 'timeout', 'xargs'];
  while (i < toks.length && (/^[A-Za-z_]\w*=/.test(toks[i]) || wrappers.includes(toks[i]) || /^\d+$/.test(toks[i]))) i++;
  return path.basename(toks[i] || '');
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

// ---------------------------------------------------------------------------
// Ветки и деплой.

const PROTECTED_BRANCH_RE = /^(main|master|dev|develop|prod|production|release(\/.*)?)$/i;
const PROD_TOKEN_RE = /(^|[^a-z])prod(uction)?([^a-z]|$)/i;

function gitPushReason(toks, seg) {
  if (toks.some((t) => /^(-f|--force|--force-with-lease.*)$/.test(t))) {
    return 'force push переписывает чужую историю';
  }
  // git push [remote] [refspec] — цель это последний свободный аргумент.
  const free = toks.slice(toks.indexOf('push') + 1).filter((t) => !t.startsWith('-'));
  const target = free[free.length - 1] || '';
  const branch = target.includes(':') ? target.split(':').pop() : target;
  if (branch && PROTECTED_BRANCH_RE.test(branch)) return `push в защищённую ветку «${branch}»`;
  // Без refspec push уходит в текущую ветку — её имени в команде нет, решает человек.
  if (free.length <= 1 && !/--dry-run/.test(seg)) return 'push уходит наружу, ветку из команды не видно';
  return null;
}

// ---------------------------------------------------------------------------
// Отправка данных наружу: curl/wget с телом запроса или загрузкой файла.

const UPLOAD_FLAG_RE = /^(-d|--data|--data-raw|--data-binary|--data-urlencode|-F|--form|-T|--upload-file|--json)$/;

function outboundReason(toks, seg) {
  const hasBody = toks.some((t) => UPLOAD_FLAG_RE.test(t) || /^--(data|form|json)=/.test(t));
  if (!hasBody) return null;
  const hosts = hostsIn(seg, toks);
  const external = hosts.filter((h) => !LOCAL_HOST_RE.test(h));
  if (external.length === 0) return null;
  const fromFile = /[@<]\s*[\w./-]+/.test(seg);
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
  'node', 'python', 'python3', 'ruby', 'php', 'deno', 'bun', 'jq', 'yq',
]);

// Копирование и передача: опасен источник, а не назначение.
const TRANSFER = new Set(['cp', 'mv', 'scp', 'rsync', 'tar', 'zip', 'install', 'ln']);

function secretPathsIn(seg, toks) {
  const found = new Set([...(String(seg).match(/[\w@.\-/\\]*\.\w+|[\w./-]*\.env[\w.]*/g) || []), ...toks]);
  // `@файл` — синтаксис curl для «взять тело из файла», сама «собака» частью
  // пути не является и мешала бы сопоставлению имени.
  return [...found].map((c) => String(c).replace(/^@/, '')).filter(isSecretPath);
}

function readsSecret(seg, toks, cmd) {
  const secrets = secretPathsIn(seg, toks);
  if (secrets.length === 0) return null;

  if (READS_FILE.has(cmd)) return secrets[0];

  if (TRANSFER.has(cmd)) {
    // Последний свободный аргумент — назначение; всё до него читается.
    const free = toks.slice(1).filter((t) => !t.startsWith('-'));
    const dest = free[free.length - 1] || '';
    return secrets.find((s) => s !== dest) || null;
  }

  // Отправка секрета наружу телом запроса: `curl -d @secrets.json`, `-T .env`.
  // Здесь запрет, а не вопрос: подтверждать утечку ключей нечем.
  if (/^(curl|wget|http|httpie)$/.test(cmd)
    && toks.some((t) => UPLOAD_FLAG_RE.test(t) || /^--(data|form|json)=/.test(t))) {
    return secrets[0];
  }

  // Цель перенаправления — запись, она безвредна: `echo X > .env`.
  const redirectTargets = [...String(seg).matchAll(/>>?\s*([\w@.\-/\\]+)/g)].map((m) => m[1]);
  const notRedirect = secrets.filter((s) => !redirectTargets.includes(s));
  if (notRedirect.length === 0) return null;

  // Остальное — команда упоминает секрет, но роли его мы не поняли. Молчим:
  // ложный запрет на `git add .env` или `ls -la .env` толкает искать обход,
  // а содержимого эти команды не показывают.
  return null;
}

export function guardBashSecurity(command) {
  const raw = String(command || '');
  if (!raw.trim()) return null;

  for (const seg of segments(raw)) {
    const toks = tokenize(seg);
    const cmd = commandName(toks);

    // Имя берём сырое и до отсева пустого cmd: commandName пропускает `env`
    // как обёртку, и голый `env` — тот самый случай, когда печатается всё
    // окружение, — иначе выпал бы из проверки вместе с пустым именем.
    const first = path.basename(toks[0] || '');
    if (toks.length === 1 && (first === 'env' || first === 'printenv' || first === 'set')) {
      return {
        level: ASK,
        reason: `\`${first}\` печатает переменные окружения целиком — среди них могут быть токены. ` +
          'Нужна одна переменная — назови её явно.',
      };
    }

    if (!cmd) continue;

    // Секреты проверяем первыми: `curl -T .env` — это не «отправка данных,
    // подтверди», а утечка ключей, и подтверждать её нечем.
    // Запрещаем только чтение: содержимое попадает в транскрипт навсегда.
    // Запись безвредна — `cp .env.example .env` и `echo X >> .env` ничего не
    // раскрывают, и блокировать их значит мешать обычной настройке проекта.
    const secret = readsSecret(seg, toks, cmd);
    if (secret) {
      return {
        level: DENY,
        reason: `\`${secret}\` — хранилище секретов, и через shell его содержимое попадёт в транскрипт навсегда. ` +
          'Нужно проверить наличие переменной — смотри `.env.example` или спроси имя у пользователя; ' +
          'нужно значение — пусть пользователь пришлёт именно его.',
      };
    }

    // Команды, печатающие окружение целиком. Секрет в них приходит не из
    // файла, а из вывода, и по имени файла его не поймать: `printenv` в
    // проекте с экспортированным токеном кладёт его в транскрипт так же
    // надёжно, как `cat .env`.
    if (/^docker(-compose)?$/.test(cmd) && toks.includes('config') && !toks.includes('--services')) {
      return {
        level: ASK,
        reason: '`docker compose config` печатает конфигурацию с подставленными переменными окружения — ' +
          'среди них могут быть токены. Нужен один сервис — `--services`.',
      };
    }

    if (DUMP_CMDS.has(cmd)) {
      return { level: ASK, reason: `\`${cmd}\` выгружает базу целиком — подтверди, если это осознанный бэкап.` };
    }

    if (DB_CLIENTS.has(cmd)) {
      const external = hostsIn(seg, toks).filter((h) => !LOCAL_HOST_RE.test(h));
      if (external.length) {
        return { level: ASK, reason: `\`${cmd}\` идёт на неместный хост ${external[0]} — это может быть боевая база.` };
      }
      if (/\.dump\b|--rdb\b|COPY\s+.*\bTO\b/i.test(seg)) {
        return { level: ASK, reason: `\`${cmd}\` выгружает содержимое базы — подтверди.` };
      }
    }

    if (cmd === 'sqlite3' && /\.dump\b/.test(seg)) {
      return { level: ASK, reason: 'sqlite3 .dump выгружает базу целиком — подтверди.' };
    }

    if (cmd === 'git' && toks.includes('push')) {
      const reason = gitPushReason(toks, seg);
      if (reason) return { level: ASK, reason: `${reason}. Публикация наружу — только с твоего подтверждения.` };
    }

    if (cmd === 'docker' || cmd === 'docker-compose') {
      const acts = ['up', 'down', 'restart', 'stack', 'push'];
      if (toks.some((t) => acts.includes(t)) && PROD_TOKEN_RE.test(seg)) {
        return { level: ASK, reason: 'команда трогает прод-конфигурацию docker — подтверди.' };
      }
    }

    if (cmd === 'kubectl' && toks.some((t) => ['apply', 'delete', 'scale', 'rollout', 'patch'].includes(t))) {
      return { level: ASK, reason: 'kubectl меняет состояние кластера — подтверди.' };
    }

    if (cmd === 'ssh' && /\b(systemctl|docker|rm|deploy|migrate)\b/.test(seg)) {
      return { level: ASK, reason: 'команда меняет состояние на удалённом хосте — подтверди.' };
    }

    if (cmd === 'curl' || cmd === 'wget' || cmd === 'http' || cmd === 'httpie') {
      const reason = outboundReason(toks, seg);
      if (reason) return { level: ASK, reason: `${reason} — подтверди, что это не утечка.` };
    }

  }
  return null;
}

export function guardReadSecurity(filePath) {
  if (!isSecretPath(filePath)) return null;
  return {
    level: DENY,
    reason: `\`${filePath}\` — хранилище секретов: прочитанное остаётся в транскрипте навсегда и уедет в любой ` +
      'следующий запрос. Структура переменных есть в `.env.example`; конкретное значение пусть пришлёт пользователь.',
  };
}

// MCP-инструменты, которые отдают содержимое файла. Они идут мимо Read, и без
// этого списка гард закрывал бы парадную дверь при открытом чёрном ходе.
// Имя файла у них лежит в разных полях, поэтому проверяем все правдоподобные.
const MCP_FILE_READERS = /^mcp__\w+__\w*(read|body|signature|context|cat|open|file)\w*$/i;

function mcpFileTarget(ti) {
  return ti.file || ti.file_path || ti.path || ti.symbol || '';
}

// Единая точка для адаптера хука.
export function securityGuard(toolName, toolInput = {}) {
  const name = String(toolName || '');
  const ti = toolInput || {};

  if (name === 'Read' || name === 'NotebookEdit') return guardReadSecurity(ti.file_path || ti.path || '');
  if (name === 'Edit' || name === 'Write') return guardReadSecurity(ti.file_path || '');
  if (name === 'Bash') return guardBashSecurity(ti.command);
  if (name === 'mcp__ide__executeCode') return guardBashSecurity(ti.code);
  if (name === 'Grep') {
    const target = ti.path || ti.glob || '';
    return isSecretPath(target) ? guardReadSecurity(target) : null;
  }
  if (MCP_FILE_READERS.test(name)) {
    const target = mcpFileTarget(ti);
    return isSecretPath(target) ? guardReadSecurity(target) : null;
  }
  return null;
}
