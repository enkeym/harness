#!/usr/bin/env node
// Кандидаты в карту неявных связей: строки, за которыми стоит связь, невидимая
// графу вызовов, собранные через `tokensave tool search` по фиксированной
// таблице паттернов. Скрипт карту не пишет — он печатает, где стоит каждая
// сторона; спаривание сторон и последствие остаются за скиллом impact-map.
// Ручной поиск давал карту на треть: `tokensave_search` отдаёт 10 строк, и
// 54 `.emit(` превращались в 7 событий.
//
// Использование: seed-impact-map.mjs [cwd] — проект берётся от cwd (git-корень).
// Код 0 — кандидаты напечатаны (пусть даже ноль); 1 — нет графа или tokensave.
// AI_HOOKS_TOKENSAVE_CMD — подмена бинаря в тестах.

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { repoRootOr } from '../state-core.mjs';
import { projectRoot } from '../guard-core.mjs';

const TOKENSAVE = process.env.AI_HOOKS_TOKENSAVE_CMD || 'tokensave';
const LIMIT = 500;
// Тесты и моки эмитят те же события, что и код, но связью не являются.
const TEST_FILE_RE = /\.(spec|test|stories)\.[jt]sx?$|(^|\/)(test|tests|__tests__|__mocks__|e2e)\//;
// Карта и документация цитируют те же строки — это не вторая сторона связи.
const PATH_EXCLUDE = ['node_modules', 'dist', 'build', '.claude/links', 'docs/links'];
// Имена переменных окружения — из примера, сам `.env` гард читать не даёт.
const ENV_EXAMPLE_RE = /^\.env(\.[\w-]+)*\.(example|sample|template)$/;
// Связь живёт в коде; строка из docs/ или .md цитирует её, а не образует.
const CODE_FILE_RE = /\.(m?[jt]sx?|cjs|vue)$/;
// `.on('click')`, `.on('style.load')`, socket.io lifecycle, `process.on(SIG…)`
// — DOM, библиотека карт и рантайм, не связь; событие проекта носит `_`,
// `${`, заглавную букву или имя константы.
const DOM_EVENT_RE = /^\.on\(\s*['"](?:[a-z.]+|connect_error|reconnect_\w+)['"]/;
const RUNTIME_ON_RE = /\bprocess\.on\(/;
// Ключ хранилища — строка или КОНСТАНТА; `.subscribe(res => …)` — RxJS.
const KEY_RE = /['"`]|\b[A-Z][A-Z0-9_]{2,}\b/;
// Флаг — `process.env.X`, `import.meta.env.X` или `'X'` в чтении конфига.
const FLAG_RE = /\b(?:process|import\.meta)\.env\.|['"`][A-Z][A-Z0-9_]+['"`]/;
// Вход извне — декоратор расписания или маршрута, либо webhook-обработчик;
// `logger.error('… handleWebhook')` и summary в @ApiOperation — упоминания.
const ENTRY_RE = /^@(?:Cron|Interval|Timeout|Post|Get|Put|Patch|Delete|All)\(|[Ww]ebhook\w*\s*\(/;

// Вид связи → буквальные строки, которые её выдают. Одна строка — один запрос.
const KINDS = [
  {
    title: 'События и очереди',
    queries: ['@OnEvent(', '.emit(', '@Process(', '@Processor(', '@SubscribeMessage(', '.on('],
    keep: (text) => {
      if (RUNTIME_ON_RE.test(text)) return false;
      const at = text.indexOf('.on(');
      return at < 0 || !DOM_EVENT_RE.test(text.slice(at));
    },
  },
  {
    title: 'Ключи хранилищ',
    queries: [
      'localStorage.', 'sessionStorage.', 'revalidateTag(', 'cacheTag(', 'queryKey',
      '.publish(', '.subscribe(', '.setex(', '.hset(', '.hget(', '.sadd(', '.expire(',
    ],
    keep: (text) => KEY_RE.test(text),
  },
  {
    title: 'Флаги и переключатели',
    // `.get('` без префикса — тысячи Map/headers по всему дереву.
    queries: ['process.env.', 'import.meta.env.', 'configService.get', 'config.get', 'getOrThrow('],
    keep: (text) => FLAG_RE.test(text),
  },
  {
    title: 'Расписание и внешние входы',
    queries: ['@Cron(', '@Interval(', '@Timeout(', 'webhook', 'Webhook'],
    keep: (text) => ENTRY_RE.test(text),
  },
];

const root = repoRootOr(process.argv[2] || process.cwd());
const say = (line) => process.stdout.write(`${line}\n`);

if (!projectRoot(root)) {
  say(`кандидаты: в ${root} нет .tokensave — impact через grep, карта не нужна`);
  process.exit(1);
}

function searchOnce(query, scope) {
  const args = { query, literal: true, limit: LIMIT, path_exclude: PATH_EXCLUDE };
  if (scope) args.path_include = [scope];
  let raw;
  try {
    raw = execFileSync(TOKENSAVE, ['tool', 'search', '--args', JSON.stringify(args), '--json'], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (e) {
    if (e.code === 'ENOENT') {
      say(`кандидаты: нет ${TOKENSAVE} в PATH — собирать вручную через tokensave_search`);
      process.exit(1);
    }
    return null;
  }
  // `tool … --json` оборачивает ответ MCP: текст лежит в content[0].text.
  const text = JSON.parse(raw).content[0].text;
  // Бинарь режет текст ответа на 15000 символах (~55 строк) и это не
  // настраивается; обрезанный JSON не разбирается — сужаем область.
  if (/\[\.\.\. truncated at \d+ chars\]\s*$/.test(text)) return null;
  return JSON.parse(text);
}

// Подкаталоги и файлы области — path_include сравнивает подстроку пути, так
// что один файл тоже годится как область.
function children(scope) {
  const dir = path.join(root, scope);
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter((e) => !e.name.startsWith('.') && e.name !== 'node_modules')
    .map((e) => (scope ? `${scope}/${e.name}` : e.name));
}

// Полный список совпадений: обрезанный ответ пересобирается из ответов по
// подкаталогам; один файл, не влезающий в ответ, попадает в `truncated`.
function search(query, scope = '') {
  const one = searchOnce(query, scope);
  if (one) return { matches: one.matches, truncated: [] };
  const target = path.join(root, scope);
  if (scope && !fs.statSync(target).isDirectory()) return { matches: [], truncated: [scope] };
  const matches = [];
  const truncated = [];
  for (const child of children(scope)) {
    const part = search(query, child);
    matches.push(...part.matches);
    truncated.push(...part.truncated);
  }
  return { matches, truncated };
}

// Символ строки. tokensave для строки-декоратора возвращает имя декоратора —
// метод стоит ниже, его берём из файла; для строки уровня файла символа нет.
function symbolOf(match) {
  const { file, line, text, enclosing } = match;
  if (!enclosing || enclosing === file) return '';
  const decorator = text.trim().match(/^@(\w+)\(/);
  if (!decorator || decorator[1] !== enclosing) return enclosing;
  const lines = fs.readFileSync(path.join(root, file), 'utf8').split('\n').slice(line, line + 6);
  for (const l of lines) {
    if (/^\s*@/.test(l)) continue;
    const method = l.match(/^\s*(?:public\s+|private\s+|protected\s+)?(?:async\s+)?(?:\*\s*)?([A-Za-z_$][\w$]*)\s*[(<]/);
    if (method) return method[1];
  }
  return enclosing;
}

function envNames() {
  const names = new Set();
  for (const name of fs.readdirSync(root)) {
    if (!ENV_EXAMPLE_RE.test(name)) continue;
    for (const [, key] of fs.readFileSync(path.join(root, name), 'utf8').matchAll(/^\s*(?:export\s+)?([A-Z][A-Z0-9_]+)\s*=/gm)) {
      names.add(key);
    }
  }
  return [...names];
}

// Порядок миграций граф не видит. Полный список ничего не говорит о
// зависимостях — печатается каталог и последняя миграция, ссылки между
// ними (таблица одной в SQL другой) ищутся по содержимому.
function migrations() {
  const found = [];
  const walk = (dir, depth) => {
    if (depth > 6) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
      const full = path.join(dir, entry.name);
      if (!entry.isDirectory()) continue;
      if (entry.name === 'migrations') {
        const files = fs.readdirSync(full).filter((f) => !f.endsWith('.toml')).sort();
        if (files.length) found.push(`- \`${path.relative(root, full)}\` — ${files.length} миграций, последняя \`${files.at(-1)}\``);
      } else {
        walk(full, depth + 1);
      }
    }
  };
  walk(root, 0);
  return found;
}

const names = envNames();
let total = 0;
const sections = [];

for (const kind of KINDS) {
  const seen = new Set();
  const lines = [];
  const truncated = [];
  for (const query of kind.queries) {
    const found = search(query);
    truncated.push(...found.truncated.map((f) => `${query} в ${f}`));
    for (const m of found.matches) {
      if (!CODE_FILE_RE.test(m.file) || TEST_FILE_RE.test(m.file)) continue;
      const text = m.text.trim();
      if (kind.keep && !kind.keep(text)) continue;
      const key = `${m.file}:${m.line}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const symbol = symbolOf(m);
      lines.push({ key, line: `- \`${m.file}${symbol ? `:${symbol}` : ''}\` (стр. ${m.line}) — \`${text.slice(0, 120)}\`` });
    }
  }
  if (!lines.length) continue;
  lines.sort((a, b) => a.key.localeCompare(b.key));
  total += lines.length;
  sections.push(`## ${kind.title} — ${lines.length}\n${lines.map((l) => l.line).join('\n')}`
    + (truncated.length ? `\nне влезло в ответ: ${truncated.join(', ')} — дочитать tokensave_search по файлу` : ''));
}

const migrationDirs = migrations();
if (migrationDirs.length) {
  total += migrationDirs.length;
  sections.push(`## Порядок миграций — ${migrationDirs.length}\n${migrationDirs.join('\n')}`);
}

say(`кандидаты: ${total} — ${root}${names.length ? ` — флаги из примера env: ${names.join(', ')}` : ''}`);
if (!total) {
  say('связей, которых граф не видит, по таблице не нашлось — контракты через границу ищутся руками');
} else {
  say(sections.join('\n\n'));
  say('\nконтракты через границу (ключи ответа, query-параметры, имена полей формы) таблица не ловит — искать руками');
}
