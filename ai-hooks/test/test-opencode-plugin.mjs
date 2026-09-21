#!/usr/bin/env node
// Тест OpenCode-плагина: tool.execute.before вызывается так же, как это делает
// OpenCode, — throw значит «вызов отклонён». Проверяется гард безопасности:
// DENY (секреты) блокирует, ASK проходит — его держит permission.bash.
// Гарды tokensave молчат: каталог сессии — не tokensave-проект, реестр
// серверов пуст.

import './env-isolate.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.TS_SERVERS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ts-servers-'));
process.env.TS_SERVE_ROOTS = '';

const { TokensaveGuard } = await import('../opencode/tokensave-guard.mjs');

const HARNESS = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
const PROJECT = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-plugin-project-'));

const hooks = await TokensaveGuard({ directory: PROJECT });
const before = hooks['tool.execute.before'];

async function verdict(tool, args) {
  try {
    await before({ tool }, { args });
    return 'allow';
  } catch (e) {
    return e.message.startsWith('security-guard') ? 'deny' : `other: ${e.message}`;
  }
}

let failed = 0;
async function check(name, tool, args, want) {
  const got = await verdict(tool, args);
  const ok = got === want;
  process.stdout.write(`${ok ? 'ok  ' : 'FAIL'} ${name} (got=${got}, want=${want})\n`);
  if (!ok) failed++;
}

// --- секреты: запрет по всем инструментам
await check('read .env', 'read', { filePath: `${PROJECT}/.env` }, 'deny');
await check('read приватного ключа', 'read', { filePath: 'deploy/id_rsa' }, 'deny');
await check('grep с include .env', 'grep', { pattern: 'TOKEN', include: '.env' }, 'deny');
await check('grep по пути .env', 'grep', { pattern: 'TOKEN', path: '.env.production' }, 'deny');
await check('edit .env', 'edit', { filePath: '.env', oldString: 'a', newString: 'b' }, 'deny');
await check('write .env', 'write', { filePath: '.env', content: 'X=1' }, 'deny');
await check('bash cat .env', 'bash', { command: 'cat .env' }, 'deny');
await check('bash токен Claude', 'bash', { command: 'cat ~/.claude/.credentials.json' }, 'deny');
await check('MCP tokensave_read .env', 'tokensave_tokensave_read', { path: '.env' }, 'deny');
await check('MCP tokensave_body ключа', 'tokensave_tokensave_body', { file: 'deploy/id_rsa' }, 'deny');

// --- ASK не блокируется плагином
await check('bash дамп БД (ask)', 'bash', { command: 'pg_dump -h prod.db mydb' }, 'allow');
await check('edit харнеса из чужого проекта (ask)', 'edit',
  { filePath: `${HARNESS}/rules/core.md`, oldString: 'a', newString: 'b' }, 'allow');

// --- обычные вызовы проходят
await check('read обычного файла', 'read', { filePath: `${PROJECT}/src/app.ts` }, 'allow');
await check('read .env.example', 'read', { filePath: '.env.example' }, 'allow');
await check('grep без пути', 'grep', { pattern: 'foo' }, 'allow');
await check('bash git status', 'bash', { command: 'git status' }, 'allow');
await check('инструмент без гарда', 'webfetch', { url: 'https://example.com' }, 'allow');
await check('MCP tokensave_read обычного файла', 'tokensave_tokensave_read', { path: 'src/app.ts' }, 'allow');
await check('todoread без пути', 'todoread', {}, 'allow');
await check('пустые args', 'read', undefined, 'allow');

process.stdout.write(failed ? `\n${failed} FAIL\n` : '\nвсе проверки пройдены\n');
process.exit(failed ? 1 : 0);
