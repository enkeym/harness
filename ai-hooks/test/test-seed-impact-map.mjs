#!/usr/bin/env node
// Тесты сбора кандидатов в карту неявных связей. Ловится то, ради чего скрипт
// написан: полнота (каждая сторона найдена, обрезанный ответ пересобран),
// символ у строки-декоратора, группировка сторон по литералу, упоминания вне
// кода и отсев шума — DOM-события, тесты, смысловые соседи ragsave.
// `tokensave` и `ragsave` подменяются fixtures/fake-tokensave.mjs и fake-ragsave.mjs.

import './env-isolate.mjs';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SCRIPT = path.join(ROOT, 'bin', 'seed-impact-map.mjs');
const FAKE = path.join(ROOT, 'test', 'fixtures', 'fake-tokensave.mjs');
const FAKE_RAG = path.join(ROOT, 'test', 'fixtures', 'fake-ragsave.mjs');
fs.chmodSync(FAKE, 0o755);
fs.chmodSync(FAKE_RAG, 0o755);

let failed = 0;
function check(name, ok, detail = '') {
  process.stdout.write(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok || !detail ? '' : ` — ${detail}`}\n`);
  if (!ok) failed++;
}

const FILES = {
  'server/src/app.gateway.ts': [
    'export class AppGateway {',
    '  @SubscribeMessage(\'joinRoom\')',
    '  async handleJoinRoom(client: Socket) {',
    '    this.server.emit(`${group}_newData`, data);',
    '    // this.server.emit(\'legacyData\', data);',
    '  }',
    '  @Cron(CronExpression.EVERY_HOUR)',
    '  cleanup() {}',
    '  onModuleInit() {',
    '    process.on(\'SIGINT\', () => {});',
    '    this.logger.error(\'ошибка в handleWebhook\');',
    '  }',
    '}',
  ].join('\n'),
  'server/src/config.service.ts': [
    'export function dbUrl(configService: ConfigService) {',
    '  return configService.get<string>(\'DATABASE_URL\') ?? process.env.DATABASE_URL;',
    '}',
    'export const LOG_DIR = process.env.APP_LOG_DIR || \'/var/log\';',
  ].join('\n'),
  'client/src/hooks/useData.ts': [
    'export function useData(socket: Socket, map: Map) {',
    '  socket.on(`${group}_newData`, handle);',
    '  map.on(\'style.load\', init);',
    '  socket.on(\'connect_error\', retry);',
    '  const raw = localStorage.getItem(DRAFT_KEY);',
    '  stream.subscribe((res) => res);',
    '  sessionStorage.setItem(INTRO_FLAG, \'1\');',
    '  const list = JSON.parse(localStorage.getItem(LIST_KEY) || \'[]\');',
    '}',
  ].join('\n'),
  'client/src/hooks/useData.spec.ts': 'socket.emit(`${group}_newData`, {});\n',
  'docs/notes.md': 'Событие `${group}_newData` шлёт `.emit(`.\n',
  'server/prisma/migrations/20260101_a/migration.sql': 'CREATE TABLE a();\n',
  'server/prisma/migrations/20260102_b/migration.sql': 'ALTER TABLE a ADD b int;\n',
  '.env.example': 'DATABASE_URL=\nFEATURE_X=1\n',
  'docker-compose.yml': 'services:\n  server:\n    environment:\n      DATABASE_URL: postgres://db/app\n',
  'ops/nginx.conf': 'proxy_pass http://server:3000;\n',
};

function project({ tokensave = true, rag = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'seed-impact-map-test-'));
  execFileSync('git', ['init', '-q'], { cwd: dir });
  if (tokensave) {
    fs.mkdirSync(path.join(dir, '.tokensave'));
    fs.writeFileSync(path.join(dir, '.tokensave', 'tokensave.db'), '');
  }
  if (rag) {
    fs.mkdirSync(path.join(dir, '.ragsave'));
    fs.writeFileSync(path.join(dir, '.ragsave', 'rag.db'), '');
  }
  for (const [rel, body] of Object.entries(FILES)) {
    const file = path.join(dir, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, body);
  }
  return dir;
}

function run(dir, env = {}) {
  try {
    return { code: 0, out: execFileSync('node', [SCRIPT, dir], { encoding: 'utf8', env: { ...process.env, AI_HOOKS_TOKENSAVE_CMD: FAKE, AI_HOOKS_RAGSAVE_CMD: FAKE_RAG, ...env } }) };
  } catch (e) {
    return { code: e.status, out: e.stdout || '' };
  }
}

// Нет ни графа, ни ragsave — карта не нужна.
{
  const { code, out } = run(project({ tokensave: false, rag: false }));
  check('без индексов — код 1', code === 1 && out.includes('нет индекса tokensave или ragsave'), out.trim());
}

// Только ragsave — стороны из git grep без символа, упоминания вне кода из
// него же; ragsave не зовётся (бинарь-заглушка отсутствует — пометки нет).
{
  const { code, out } = run(project({ tokensave: false }), {
    AI_HOOKS_TOKENSAVE_CMD: '/nonexistent/tokensave',
    AI_HOOKS_RAGSAVE_CMD: '/nonexistent/ragsave',
  });
  const events = section(out, 'События и очереди');
  const contracts = section(out, 'Контракты и доки');
  check('git grep: код 0, tokensave и ragsave не зовутся',
    code === 0 && !out.includes('/nonexistent/'), out.trim());
  check('git grep: эмит и слушатель в группе, строка без символа',
    events.includes('### `${group}_newData` — 2\n- `client/src/hooks/useData.ts` (стр. 2)')
    && events.includes('- `server/src/app.gateway.ts` (стр. 4)'), events);
  check('git grep: spec и комментарий не стороны', !events.includes('useData.spec.ts') && !out.includes('legacyData'), events);
  check('git grep: env и compose в контрактах',
    contracts.includes('### `DATABASE_URL` — в коде одна сторона\n- `.env.example` (стр. 1)')
    && contracts.includes('- `docker-compose.yml` (стр. 4)'), contracts);
}

// Нет бинаря — честный отказ, а не пустая карта.
{
  const { code, out } = run(project(), { AI_HOOKS_TOKENSAVE_CMD: '/nonexistent/tokensave' });
  check('без tokensave в PATH — код 1', code === 1 && out.includes('нет /nonexistent/tokensave'), out.trim());
}

// Тело секции `## <title>` до следующей секции.
function section(out, title) {
  const at = out.indexOf(`\n## ${title}`);
  if (at < 0) return '';
  const end = out.indexOf('\n## ', at + 1);
  return out.slice(at, end < 0 ? undefined : end);
}

function expectFull(out, label) {
  const has = (s) => out.includes(s);
  const events = section(out, 'События и очереди');
  const contracts = section(out, 'Контракты и доки');
  check(`${label}: декоратор → метод`, has('`server/src/app.gateway.ts:handleJoinRoom` (стр. 2)'), out);
  check(`${label}: эмит и слушатель в одной группе литерала`,
    events.includes('### `${group}_newData` — 2\n- `client/src/hooks/useData.ts:useData` (стр. 2)')
    && events.includes('- `server/src/app.gateway.ts:handleJoinRoom` (стр. 4)'), events);
  check(`${label}: литерал с одной строкой помечен`, events.includes('### `joinRoom` — одна сторона') && events.includes('(с одной стороной: 1)'), events);
  check(`${label}: cron с методом`, has('`server/src/app.gateway.ts:cleanup` (стр. 7)'));
  const keys = section(out, 'Ключи хранилищ');
  check(`${label}: ключ localStorage под константой`, keys.includes('### `DRAFT_KEY` — одна сторона\n- `client/src/hooks/useData.ts:useData` (стр. 5)'));
  check(`${label}: значение '1' и '[]' не литерал — ключ из константы`,
    keys.includes('### `INTRO_FLAG` — одна сторона\n- `client/src/hooks/useData.ts:useData` (стр. 7)')
    && keys.includes('### `LIST_KEY` — одна сторона\n- `client/src/hooks/useData.ts:useData` (стр. 8)')
    && !keys.includes('### `[]`') && !keys.includes('без литерала'), keys);
  const flags = section(out, 'Флаги и переключатели');
  check(`${label}: флаг из configService и process.env`, flags.includes('### `DATABASE_URL` — одна сторона\n- `server/src/config.service.ts:dbUrl` (стр. 2)'));
  check(`${label}: литерал флага — имя env, не константа слева`, flags.includes('### `APP_LOG_DIR` — одна сторона') && !flags.includes('### `LOG_DIR`'), flags);
  check(`${label}: закомментированный emit не сторона`, !has('legacyData'));
  check(`${label}: миграции сводкой`, has('`server/prisma/migrations` — 2 миграций, последняя `20260102_b`'));
  check(`${label}: имена флагов из .env.example`, has('DATABASE_URL, FEATURE_X'));
  check(`${label}: DOM/lifecycle отсеяны`, !has('style.load') && !has('connect_error') && !has('SIGINT'));
  check(`${label}: RxJS subscribe отсеян`, !has('stream.subscribe'));
  check(`${label}: логгер про webhook отсеян`, !has('handleWebhook'));
  check(`${label}: spec отсеян, docs не сторона`, !has('useData.spec.ts') && !events.includes('docs/notes.md'));
  check(`${label}: doc из индекса — в контрактах`, contracts.includes('### `${group}_newData`\n- `docs/notes.md` (стр. 1)'), contracts);
  check(`${label}: env и compose из ragsave, строка чанка по смещению`,
    contracts.includes('### `DATABASE_URL` — в коде одна сторона\n- `.env.example` (стр. 1) — `DATABASE_URL=`\n- `docker-compose.yml` (стр. 4) — `DATABASE_URL: postgres://db/app`'), contracts);
  check(`${label}: смысловой сосед без литерала отсеян`, !has('nginx.conf'));
  check(`${label}: контракты без литерала названы ручной работой`, has('контракты через границу'));
}

// Полный ответ.
{
  const { code, out } = run(project());
  check('код 0 с кандидатами', code === 0 && /^кандидаты: \d+ — /.test(out), out.split('\n')[0]);
  expectFull(out, 'полный ответ');
}

// Обрезанный ответ пересобирается по подкаталогам — те же кандидаты.
{
  const full = run(project()).out;
  const { code, out } = run(project(), { FAKE_TOKENSAVE_MAX_CHARS: '1500' });
  check('обрезанный ответ — код 0', code === 0, out.trim());
  expectFull(out, 'обрезанный ответ');
  // Первая строка несёт путь временного каталога — сравниваются кандидаты.
  const body = (s) => s.split('\n').slice(1).join('\n');
  check('обрезанный ответ совпадает с полным', body(out) === body(full), body(out));
}

// Один файл не влезает в ответ — об этом сказано, а не потеряно молча.
{
  const { code, out } = run(project(), { FAKE_TOKENSAVE_MAX_CHARS: '300' });
  check('файл не влез — код 0 и пометка', code === 0 && /не влезло в ответ: .*\.on\( в client\/src\/hooks\/useData\.ts/.test(out), out.trim());
}

// Нет rag.db — ragsave не зовётся, упоминания из индекса tokensave остаются.
{
  const { code, out } = run(project({ rag: false }), { AI_HOOKS_RAGSAVE_CMD: '/nonexistent/ragsave' });
  const contracts = section(out, 'Контракты и доки');
  // `.env.example` видит только ragsave: подмена tokensave dot-файлы не читает.
  check('без rag.db — ragsave не зовётся', code === 0 && !out.includes('/nonexistent/ragsave') && !out.includes('- `.env.example`'), out.trim());
  check('без rag.db — doc из индекса в контрактах', contracts.includes('- `docs/notes.md` (стр. 1)'), contracts);
}

// Есть rag.db, нет бинаря — пометка, остальное на месте.
{
  const { code, out } = run(project(), { AI_HOOKS_RAGSAVE_CMD: '/nonexistent/ragsave' });
  check('без ragsave в PATH — код 0 и пометка', code === 0 && out.includes('кандидаты: нет /nonexistent/ragsave в PATH') && !out.includes('- `.env.example`'), out.trim());
  check('без ragsave в PATH — кандидаты из графа на месте', out.includes('### `${group}_newData` — 2'), out.trim());
}

process.stdout.write(failed ? `\n${failed} FAIL\n` : '\nвсе тесты seed-impact-map зелёные\n');
process.exit(failed ? 1 : 0);
