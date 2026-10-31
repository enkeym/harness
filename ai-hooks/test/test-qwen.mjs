import './env-isolate.mjs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const root = path.resolve(import.meta.dirname, '../..');
test('Qwen install repairs dangling skills, preserves settings and checks drift without writes', t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-install-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const qwenHome = path.join(home, '.qwen');
  fs.mkdirSync(path.join(qwenHome, 'skills'), { recursive: true });
  const bin = path.join(home, 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'qwen'), '#!/bin/sh\necho fake-qwen\n', { mode: 0o755 });
  const settings = path.join(qwenHome, 'settings.json');
  const warm = 'bash "$HOME/.ai-hooks/bin/ragsave-sync.sh" --warm "$QWEN_PROJECT_DIR"';
  fs.writeFileSync(settings, JSON.stringify({
    model: { name: 'user-model' },
    mcpServers: { custom: { command: 'user-server' }, tokensave: { command: 'old', trust: true } },
    hooks: { SessionStart: [{ hooks: [{ type: 'command', command: warm, timeout: 10 }] }],
      Stop: [{ hooks: [{ type: 'command', command: 'echo custom' }] }] },
  }));
  fs.symlinkSync('/missing/old-harness', path.join(qwenHome, 'skills', 'python'));
  const run = (...args) => spawnSync('bash', [path.join(root, 'install.sh'), '--qwen', ...args], {
    env: { ...process.env, HOME: home, QWEN_HOME: qwenHome, PATH: `${bin}:${process.env.PATH}` }, encoding: 'utf8',
  });
  const before = fs.readFileSync(settings, 'utf8');
  assert.equal(run('--check').status, 1);
  assert.equal(fs.readFileSync(settings, 'utf8'), before);
  assert.equal(fs.readlinkSync(path.join(qwenHome, 'skills', 'python')), '/missing/old-harness');
  const installed = run();
  assert.equal(installed.status, 0, installed.stderr + installed.stdout);
  const after = JSON.parse(fs.readFileSync(settings, 'utf8'));
  assert.deepEqual(after.model, { name: 'user-model' });
  assert.deepEqual(after.mcpServers.custom, { command: 'user-server' });
  assert.equal(after.mcpServers.tokensave.trust, true);
  assert.equal(after.hooks.SessionStart[0].hooks[0].timeout, 10000);
  assert.equal(after.hooks.Stop[0].hooks[0].command, 'echo custom');
  assert.equal(after.hooks.Stop.length, 2);
  assert.equal(fs.realpathSync(path.join(qwenHome, 'skills', 'python')), path.join(root, 'skills/python'));
  assert.ok(fs.existsSync(path.join(qwenHome, 'QWEN.md')));
  assert.equal(run('--check').status, 0);
  const snapshot = fs.readFileSync(settings, 'utf8');
  assert.equal(run().status, 0);
  assert.equal(fs.readFileSync(settings, 'utf8'), snapshot);
  assert.equal(run('--unknown').status, 2);
});

test('Qwen sync unwraps catalog proxy while retaining custom servers and options', t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-mcp-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  fs.mkdirSync(path.join(home, 'bin'));
  fs.mkdirSync(path.join(home, 'mcp'));
  fs.mkdirSync(path.join(home, '.qwen'));
  const script = path.join(home, 'bin/mcp-sync.mjs');
  fs.copyFileSync(path.join(root, 'bin/mcp-sync.mjs'), script);
  fs.writeFileSync(path.join(home, 'mcp/servers.json'), JSON.stringify({
    playwright: { command: process.execPath, args: ['~/mcp-proxy.mjs', '--catalog', '~/catalog.json', '--', process.execPath, '--version'] },
  }));
  const settings = path.join(home, '.qwen/settings.json');
  fs.writeFileSync(settings, JSON.stringify({ mcpServers: {
    playwright: { httpUrl: 'http://localhost:1', trust: true }, custom: { command: 'custom' },
  } }));
  const result = spawnSync(process.execPath, [script, '--qwen'], {
    env: { ...process.env, HOME: home, QWEN_HOME: path.join(home, '.qwen') }, encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  const actual = JSON.parse(fs.readFileSync(settings, 'utf8')).mcpServers;
  assert.deepEqual(actual.playwright, { trust: true, command: process.execPath, args: ['--version'], env: {} });
  assert.deepEqual(actual.custom, { command: 'custom' });
});
