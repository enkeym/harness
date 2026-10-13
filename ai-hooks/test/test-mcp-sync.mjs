#!/usr/bin/env node
// Тесты bin/mcp-sync.mjs: --check только сообщает о расхождениях и выходит с
// кодом 1, ничего не меняя; синхронизация регистрирует в Claude только отличающиеся серверы — изменённый снимается и
// добавляется заново. Скрипт берёт пути от своего расположения, поэтому
// запускается копия во временном дереве; `claude` подменён через PATH.

import './env-isolate.mjs';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HARNESS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

let failed = 0;
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  process.stdout.write(`${ok ? 'ok  ' : 'FAIL'} ${name} (got=${JSON.stringify(got)}, want=${JSON.stringify(want)})\n`);
  if (!ok) failed++;
}

const SERVERS = {
  alpha: { command: '~/bin/alpha', args: ['serve'], env: { A: '1' } },
  beta: { command: '/usr/bin/beta' },
};

function sandbox({ claudeServers, servers = SERVERS }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-sync-'));
  const tree = path.join(dir, 'harness');
  const home = path.join(dir, 'home');
  const fakeBin = path.join(dir, 'fake-bin');
  for (const d of ['bin', 'mcp']) fs.mkdirSync(path.join(tree, d), { recursive: true });
  fs.mkdirSync(home);
  fs.mkdirSync(fakeBin);

  fs.copyFileSync(path.join(HARNESS, 'bin', 'mcp-sync.mjs'), path.join(tree, 'bin', 'mcp-sync.mjs'));
  fs.writeFileSync(path.join(tree, 'mcp', 'servers.json'), JSON.stringify(servers));
  if (claudeServers) fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ projects: {}, mcpServers: claudeServers }));

  // Подмена claude: каждый вызов — строка argv в журнале.
  const log = path.join(dir, 'claude-calls.log');
  fs.writeFileSync(path.join(fakeBin, 'claude'), '#!/bin/sh\nprintf \'%s\\n\' "$*" >> "$FAKE_CLAUDE_LOG"\n', { mode: 0o755 });

  const run = (...args) => spawnSync('node', [path.join(tree, 'bin', 'mcp-sync.mjs'), ...args], {
    encoding: 'utf8',
    env: { ...process.env, HOME: home, PATH: `${fakeBin}:${process.env.PATH}`, FAKE_CLAUDE_LOG: log },
  });
  const calls = () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n') : []);
  return { dir, home, fakeBin, run, calls };
}

const plain = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');

// Сервер alpha в том виде, в каком его ждёт Claude.
const alphaClaude = (home) => ({ command: path.join(home, 'bin', 'alpha'), args: ['serve'], env: { A: '1' } });

// --- --check ---
{
  const sb = sandbox({ claudeServers: {} });
  fs.writeFileSync(path.join(sb.home, '.claude.json'), JSON.stringify({ mcpServers: { alpha: alphaClaude(sb.home), gamma: {} } }));
  const res = sb.run('--check');
  const out = plain(res.stdout);

  check('check: расхождение → код 1', res.status, 1);
  check('check: совпавший в Claude — ✓', out.includes('✓ alpha'), true);
  check('check: незарегистрированный в Claude', out.includes('beta — не зарегистрирован'), true);
  check('check: лишний в Claude — предупреждение', out.includes('gamma — зарегистрирован в Claude, нет в servers.json'), true);
  check('check: claude не вызывается', sb.calls(), []);
}

// --- синхронизация ---
{
  const sb = sandbox({ claudeServers: {} });
  fs.writeFileSync(path.join(sb.home, '.claude.json'), JSON.stringify({ mcpServers: { alpha: { ...alphaClaude(sb.home), args: ['old'] } } }));
  const res = sb.run();

  check('sync: код 0', res.status, 0);

  const calls = sb.calls();
  check('sync: изменённый в Claude снят и добавлен заново, новый — добавлен', calls, [
    'mcp remove -s user alpha',
    `mcp add-json -s user alpha ${JSON.stringify({ type: 'stdio', command: path.join(sb.home, 'bin', 'alpha'), args: ['serve'], env: { A: '1' } })}`,
    `mcp add-json -s user beta ${JSON.stringify({ type: 'stdio', command: '/usr/bin/beta', args: [], env: {} })}`,
  ]);

}

// --- Claude уже совпадает ---
{
  const sb = sandbox({ claudeServers: {} });
  fs.writeFileSync(path.join(sb.home, '.claude.json'),
    JSON.stringify({ mcpServers: { alpha: alphaClaude(sb.home), beta: { command: '/usr/bin/beta' } } }));
  sb.run();
  check('совпавшие серверы claude не трогает', sb.calls(), []);
}

// --- голое имя команды ищется по PATH ---
{
  const sb = sandbox({ claudeServers: {}, servers: { delta: { command: 'delta-mcp', args: ['--x'] } } });
  const bin = path.join(sb.fakeBin, 'delta-mcp');
  fs.writeFileSync(bin, '#!/bin/sh\n', { mode: 0o755 });
  const res = sb.run();
  check('PATH: код 0', res.status, 0);
  check('PATH: в Claude — найденный путь', sb.calls(),
    [`mcp add-json -s user delta ${JSON.stringify({ type: 'stdio', command: bin, args: ['--x'], env: {} })}`]);

  // Бинарь переехал (сменилась версия node) — записанный путь устарел.
  fs.writeFileSync(path.join(sb.home, '.claude.json'),
    JSON.stringify({ mcpServers: { delta: { command: '/old/node/bin/delta-mcp', args: ['--x'] } } }));
  const stale = sb.run('--check');
  check('PATH: устаревший путь → расхождение', [stale.status, plain(stale.stdout).includes('delta — отличается от servers.json')], [1, true]);
}

{
  const sb = sandbox({
    claudeServers: { gone: { command: '/old/gone-mcp' } },
    servers: { gone: { command: 'gone-mcp-nowhere' }, beta: { command: '/usr/bin/beta' } },
  });
  const res = sb.run();
  const out = plain(res.stdout);
  check('нет в PATH: код 1 и причина', [res.status, out.includes('gone — команда gone-mcp-nowhere не найдена в PATH')], [1, true]);
  check('нет в PATH: не «нет в servers.json»', out.includes('gone — зарегистрирован в Claude'), false);
  check('нет в PATH: claude не трогает сервер', sb.calls().some((c) => c.includes('gone')), false);
}

// --- нет ~/.claude.json ---
{
  const sb = sandbox({ claudeServers: null });
  const res = sb.run('--check');
  check('нет ~/.claude.json: код 1 и подсказка', [res.status, plain(res.stdout).includes('~/.claude.json нет')], [1, true]);
  check('нет ~/.claude.json: claude не вызывается', sb.calls(), []);
}

process.stdout.write(failed ? `\n=== ${failed} проверок упало ===\n` : '\n=== все проверки прошли ===\n');
process.exit(failed ? 1 : 0);
