#!/usr/bin/env node
// Тесты сбора кандидатов в карту неявных связей. Ловится то, ради чего скрипт
// написан: полнота (каждая сторона найдена, обрезанный ответ пересобран),
// символ у строки-декоратора и отсев шума — DOM-события, тесты, документация.
// `tokensave` подменяется fixtures/fake-tokensave.mjs.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SCRIPT = path.join(ROOT, 'bin', 'seed-impact-map.mjs');
const FAKE = path.join(ROOT, 'test', 'fixtures', 'fake-tokensave.mjs');
fs.chmodSync(FAKE, 0o755);

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
  ].join('\n'),
  'client/src/hooks/useData.ts': [
    'export function useData(socket: Socket, map: Map) {',
    '  socket.on(`${group}_newData`, handle);',
    '  map.on(\'style.load\', init);',
    '  socket.on(\'connect_error\', retry);',
    '  const raw = localStorage.getItem(DRAFT_KEY);',
    '  stream.subscribe((res) => res);',
    '}',
  ].join('\n'),
  'client/src/hooks/useData.spec.ts': 'socket.emit(`${group}_newData`, {});\n',
  'docs/notes.md': 'Событие `${group}_newData` шлёт `.emit(`.\n',
  'server/prisma/migrations/20260101_a/migration.sql': 'CREATE TABLE a();\n',
  'server/prisma/migrations/20260102_b/migration.sql': 'ALTER TABLE a ADD b int;\n',
  '.env.example': 'DATABASE_URL=\nFEATURE_X=1\n',
};

function project({ tokensave = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'seed-impact-map-test-'));
  execFileSync('git', ['init', '-q'], { cwd: dir });
  if (tokensave) {
    fs.mkdirSync(path.join(dir, '.tokensave'));
    fs.writeFileSync(path.join(dir, '.tokensave', 'tokensave.db'), '');
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
    return { code: 0, out: execFileSync('node', [SCRIPT, dir], { encoding: 'utf8', env: { ...process.env, AI_HOOKS_TOKENSAVE_CMD: FAKE, ...env } }) };
  } catch (e) {
    return { code: e.status, out: e.stdout || '' };
  }
}

// Нет графа — кандидатов не собрать.
{
  const { code, out } = run(project({ tokensave: false }));
  check('без .tokensave — код 1', code === 1 && out.includes('нет .tokensave'), out.trim());
}

// Нет бинаря — честный отказ, а не пустая карта.
{
  const { code, out } = run(project(), { AI_HOOKS_TOKENSAVE_CMD: '/nonexistent/tokensave' });
  check('без tokensave в PATH — код 1', code === 1 && out.includes('нет /nonexistent/tokensave'), out.trim());
}

function expectFull(out, label) {
  const has = (s) => out.includes(s);
  check(`${label}: декоратор → метод`, has('`server/src/app.gateway.ts:handleJoinRoom` (стр. 2)'), out);
  check(`${label}: эмит и слушатель события`, has('app.gateway.ts:handleJoinRoom` (стр. 4)') && has('useData.ts:useData` (стр. 2)'));
  check(`${label}: cron с методом`, has('`server/src/app.gateway.ts:cleanup` (стр. 6)'));
  check(`${label}: ключ localStorage`, has('useData.ts:useData` (стр. 5)'));
  check(`${label}: флаг из configService и process.env`, has('config.service.ts:dbUrl` (стр. 2)'));
  check(`${label}: миграции сводкой`, has('`server/prisma/migrations` — 2 миграций, последняя `20260102_b`'));
  check(`${label}: имена флагов из .env.example`, has('DATABASE_URL, FEATURE_X'));
  check(`${label}: DOM/lifecycle отсеяны`, !has('style.load') && !has('connect_error') && !has('SIGINT'));
  check(`${label}: RxJS subscribe отсеян`, !has('stream.subscribe'));
  check(`${label}: логгер про webhook отсеян`, !has('handleWebhook'));
  check(`${label}: spec и docs отсеяны`, !has('useData.spec.ts') && !has('docs/notes.md'));
  check(`${label}: контракты названы ручной работой`, has('контракты через границу'));
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
  check('файл не влез — код 0 и пометка', code === 0 && out.includes('не влезло в ответ: .on( в client/src/hooks/useData.ts'), out.trim());
}

process.stdout.write(failed ? `\n${failed} FAIL\n` : '\nвсе тесты seed-impact-map зелёные\n');
process.exit(failed ? 1 : 0);
