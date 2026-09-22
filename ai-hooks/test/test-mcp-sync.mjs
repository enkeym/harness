#!/usr/bin/env node
// Тесты bin/mcp-sync.mjs: --check только сообщает о расхождениях и выходит с
// кодом 1, ничего не меняя; синхронизация переписывает блок mcp в
// opencode.json (остальные поля и чужие серверы на месте, ~/ раскрыт) и
// регистрирует в Claude только отличающиеся серверы — изменённый снимается и
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

function sandbox({ opencodeMcp, claudeServers, servers = SERVERS }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-sync-'));
  const tree = path.join(dir, 'harness');
  const home = path.join(dir, 'home');
  const fakeBin = path.join(dir, 'fake-bin');
  for (const d of ['bin', 'mcp', 'opencode']) fs.mkdirSync(path.join(tree, d), { recursive: true });
  fs.mkdirSync(home);
  fs.mkdirSync(fakeBin);

  fs.copyFileSync(path.join(HARNESS, 'bin', 'mcp-sync.mjs'), path.join(tree, 'bin', 'mcp-sync.mjs'));
  fs.writeFileSync(path.join(tree, 'mcp', 'servers.json'), JSON.stringify(servers));
  fs.writeFileSync(path.join(tree, 'opencode', 'opencode.json'),
    JSON.stringify({ $schema: 'https://opencode.ai/config.json', mcp: opencodeMcp, agent: { x: 1 } }, null, 2));
  if (claudeServers) fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ projects: {}, mcpServers: claudeServers }));

  // Подмена claude: каждый вызов — строка argv в журнале.
  const log = path.join(dir, 'claude-calls.log');
  fs.writeFileSync(path.join(fakeBin, 'claude'), '#!/bin/sh\nprintf \'%s\\n\' "$*" >> "$FAKE_CLAUDE_LOG"\n', { mode: 0o755 });

  const run = (...args) => spawnSync('node', [path.join(tree, 'bin', 'mcp-sync.mjs'), ...args], {
    encoding: 'utf8',
    env: { ...process.env, HOME: home, PATH: `${fakeBin}:${process.env.PATH}`, FAKE_CLAUDE_LOG: log },
  });
  const calls = () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n') : []);
  const opencode = () => JSON.parse(fs.readFileSync(path.join(tree, 'opencode', 'opencode.json'), 'utf8'));
  return { dir, home, fakeBin, run, calls, opencode };
}

const plain = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');

// Сервер alpha в том виде, в каком его ждут агенты.
const alphaClaude = (home) => ({ command: path.join(home, 'bin', 'alpha'), args: ['serve'], env: { A: '1' } });

// --- --check ---
{
  const sb = sandbox({ opencodeMcp: { alpha: { type: 'local', command: ['old'] }, extra: { type: 'local', command: ['x'] } }, claudeServers: {} });
  fs.writeFileSync(path.join(sb.home, '.claude.json'), JSON.stringify({ mcpServers: { alpha: alphaClaude(sb.home), gamma: {} } }));
  const before = fs.readFileSync(path.join(sb.dir, 'harness', 'opencode', 'opencode.json'), 'utf8');
  const res = sb.run('--check');
  const out = plain(res.stdout);

  check('check: расхождение → код 1', res.status, 1);
  check('check: чужой сервер OpenCode — предупреждение', out.includes('extra — есть в opencode.json, нет в servers.json'), true);
  check('check: устаревший и отсутствующий в OpenCode',
    [out.includes('alpha — отличается от servers.json'), out.includes('beta — отличается от servers.json')], [true, true]);
  check('check: совпавший в Claude — ✓', out.includes('✓ alpha'), true);
  check('check: незарегистрированный в Claude', out.includes('beta — не зарегистрирован'), true);
  check('check: лишний в Claude — предупреждение', out.includes('gamma — зарегистрирован в Claude, нет в servers.json'), true);
  check('check: opencode.json не тронут', fs.readFileSync(path.join(sb.dir, 'harness', 'opencode', 'opencode.json'), 'utf8'), before);
  check('check: claude не вызывается', sb.calls(), []);
}

// --- синхронизация ---
{
  const sb = sandbox({ opencodeMcp: { alpha: { type: 'local', command: ['old'] }, extra: { type: 'local', command: ['x'] } }, claudeServers: {} });
  fs.writeFileSync(path.join(sb.home, '.claude.json'), JSON.stringify({ mcpServers: { alpha: { ...alphaClaude(sb.home), args: ['old'] } } }));
  const res = sb.run();
  const cfg = sb.opencode();

  check('sync: код 0', res.status, 0);
  check('sync: порядок ключей файла сохранён', Object.keys(cfg), ['$schema', 'mcp', 'agent']);
  check('sync: прочие поля на месте', cfg.agent, { x: 1 });
  check('sync: mcp — из servers.json, чужой сервер сохранён', Object.keys(cfg.mcp), ['alpha', 'beta', 'extra']);
  check('sync: ~/ раскрыт, env → environment',
    cfg.mcp.alpha, { type: 'local', command: [path.join(sb.home, 'bin', 'alpha'), 'serve'], environment: { A: '1' } });
  check('sync: без env нет environment', cfg.mcp.beta, { type: 'local', command: ['/usr/bin/beta'] });

  const calls = sb.calls();
  check('sync: изменённый в Claude снят и добавлен заново, новый — добавлен', calls, [
    'mcp remove -s user alpha',
    `mcp add-json -s user alpha ${JSON.stringify({ type: 'stdio', command: path.join(sb.home, 'bin', 'alpha'), args: ['serve'], env: { A: '1' } })}`,
    `mcp add-json -s user beta ${JSON.stringify({ type: 'stdio', command: '/usr/bin/beta', args: [], env: {} })}`,
  ]);

  const again = plain(sb.run('--check').stdout);
  check('sync → check: OpenCode совпадает', again.includes('совпадает: alpha, beta'), true);
}

// --- Claude уже совпадает ---
{
  const sb = sandbox({ opencodeMcp: {}, claudeServers: {} });
  fs.writeFileSync(path.join(sb.home, '.claude.json'),
    JSON.stringify({ mcpServers: { alpha: alphaClaude(sb.home), beta: { command: '/usr/bin/beta' } } }));
  sb.run();
  check('совпавшие серверы claude не трогает', sb.calls(), []);
}

// --- голое имя команды ищется по PATH ---
{
  const sb = sandbox({ opencodeMcp: {}, claudeServers: {}, servers: { delta: { command: 'delta-mcp', args: ['--x'] } } });
  const bin = path.join(sb.fakeBin, 'delta-mcp');
  fs.writeFileSync(bin, '#!/bin/sh\n', { mode: 0o755 });
  const res = sb.run();
  check('PATH: код 0', res.status, 0);
  check('PATH: в OpenCode — найденный путь', sb.opencode().mcp.delta, { type: 'local', command: [bin, '--x'] });
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
    opencodeMcp: { gone: { type: 'local', command: ['/old/gone-mcp'] } }, claudeServers: { gone: { command: '/old/gone-mcp' } },
    servers: { gone: { command: 'gone-mcp-nowhere' }, beta: { command: '/usr/bin/beta' } },
  });
  const res = sb.run();
  const out = plain(res.stdout);
  check('нет в PATH: код 1 и причина', [res.status, out.includes('gone — команда gone-mcp-nowhere не найдена в PATH')], [1, true]);
  check('нет в PATH: не «нет в servers.json»', out.includes('gone — есть в opencode.json') || out.includes('gone — зарегистрирован в Claude'), false);
  check('нет в PATH: запись OpenCode не тронута, остальные синхронизированы',
    sb.opencode().mcp, { beta: { type: 'local', command: ['/usr/bin/beta'] }, gone: { type: 'local', command: ['/old/gone-mcp'] } });
  check('нет в PATH: claude не трогает сервер', sb.calls().some((c) => c.includes('gone')), false);
}

// --- нет ~/.claude.json ---
{
  const sb = sandbox({ opencodeMcp: {}, claudeServers: null });
  const res = sb.run('--check');
  check('нет ~/.claude.json: код 1 и подсказка', [res.status, plain(res.stdout).includes('~/.claude.json нет')], [1, true]);
  check('нет ~/.claude.json: claude не вызывается', sb.calls(), []);
}

process.stdout.write(failed ? `\n=== ${failed} проверок упало ===\n` : '\n=== все проверки прошли ===\n');
process.exit(failed ? 1 : 0);
