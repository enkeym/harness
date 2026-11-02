import './env-isolate.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { setTimeout } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const hooksRoot = fileURLToPath(new URL('../', import.meta.url));
const script = path.join(hooksRoot, 'bin/tokensave-sync.sh');
const config = JSON.parse(fs.readFileSync(path.join(hooksRoot, '../codex/hooks.json'), 'utf8'));

function sandbox(t, { db = true } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tokensave-sync-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const root = path.join(home, 'project space $(literal)');
  fs.mkdirSync(root);
  assert.equal(spawnSync('git', ['init', '-q'], { cwd: root }).status, 0);
  fs.mkdirSync(path.join(root, '.tokensave'));
  if (db) fs.writeFileSync(path.join(root, '.tokensave/tokensave.db'), '');
  const bin = path.join(home, '.ai-hooks/bin');
  fs.mkdirSync(bin, { recursive: true });
  for (const name of ['tokensave-sync.sh', 'background.sh', 'log-error.sh']) {
    fs.symlinkSync(path.join(hooksRoot, 'bin', name), path.join(bin, name));
  }
  const calls = path.join(home, 'calls');
  const env = { ...process.env, HOME: home, CODEX_PROJECT_DIR: home,
    AI_HOOKS_TOKENSAVE_CMD: path.join(hooksRoot, 'test/fixtures/fake-indexer.mjs'),
    FAKE_INDEXER_CALLS: calls, AI_HOOKS_LOG_DIR: path.join(home, 'logs') };
  const run = (cwd = root, extra = {}, command) => {
    const result = spawnSync('bash', command ? ['-c', command] : [script, cwd],
      { cwd, env: { ...env, ...extra }, encoding: 'utf8', timeout: 10000 });
    assert.deepEqual([result.status, result.stdout, result.stderr], [0, '', '']);
  };
  return { home, root, run, calls, log: path.join(root, '.tokensave/sync.log') };
}

async function waitFor(predicate) {
  const deadline = Date.now() + 5000;
  while (!predicate() && Date.now() < deadline) await setTimeout(25);
  assert.ok(predicate(), 'фоновая задача завершилась');
}

for (const event of ['SessionStart', 'Stop']) {
  test(`${event}: sync ближайшего индекса cwd, независимо от CODEX_PROJECT_DIR`, async (t) => {
    const sb = sandbox(t);
    const nested = path.join(sb.root, 'nested');
    fs.mkdirSync(nested);
    const handler = config.hooks[event][0].hooks.find(h => h.command.includes('tokensave-sync.sh'));
    assert.ok(handler);
    sb.run(nested, {}, handler.command);
    await waitFor(() => fs.existsSync(sb.log));
    assert.deepEqual(JSON.parse(fs.readFileSync(sb.calls, 'utf8')), ['sync', sb.root]);
  });
}

test('подкаталог со своим индексом выбирается раньше корня', async (t) => {
  const sb = sandbox(t);
  const nested = path.join(sb.root, 'package');
  fs.mkdirSync(path.join(nested, '.tokensave'), { recursive: true });
  fs.writeFileSync(path.join(nested, '.tokensave/tokensave.db'), '');
  sb.run(nested);
  await waitFor(() => fs.existsSync(path.join(nested, '.tokensave/sync.log')));
  assert.deepEqual(JSON.parse(fs.readFileSync(sb.calls, 'utf8')), ['sync', nested]);
});

for (const mode of ['no index', 'disabled', 'outside git']) {
  test(`${mode}: sync и init не запускаются`, async (t) => {
    const sb = sandbox(t, { db: mode !== 'no index' });
    if (mode === 'disabled') fs.writeFileSync(path.join(sb.root, '.tokensave-disable'), '');
    sb.run(mode === 'outside git' ? sb.home : sb.root);
    await setTimeout(150);
    assert.equal(fs.existsSync(sb.calls), false);
    assert.equal(fs.existsSync(sb.log), false);
  });
}

test('ошибка sync сохраняется в отчёте и общем журнале', async (t) => {
  const sb = sandbox(t);
  sb.run(sb.root, { FAKE_INDEXER_EXIT: '7' });
  await waitFor(() => fs.existsSync(sb.log));
  assert.match(fs.readFileSync(path.join(sb.home, 'logs/errors.log'), 'utf8'), /tokensave sync.*exit=7/);
});

test('занятый lock не затирает предыдущий отчёт и не пишет ошибку', async (t) => {
  const sb = sandbox(t);
  fs.writeFileSync(sb.log, 'previous');
  const busy = path.join(sb.home, 'busy');
  fs.writeFileSync(busy, '#!/usr/bin/env bash\nprintf "[]\\n" >>"$FAKE_INDEXER_CALLS"\necho "another sync is already in progress"\nexit 1\n', { mode: 0o755 });
  sb.run(sb.root, { AI_HOOKS_TOKENSAVE_CMD: busy });
  await waitFor(() => fs.existsSync(sb.calls));
  await waitFor(() => fs.readdirSync(path.dirname(sb.log)).every(name => !name.startsWith('sync.log.')));
  assert.equal(fs.readFileSync(sb.log, 'utf8'), 'previous');
  assert.equal(fs.existsSync(path.join(sb.home, 'logs/errors.log')), false);
});

test('старые остатки sync удаляются, свежие файлы и основной отчёт сохраняются', async t => {
  const sb = sandbox(t);
  const old = `${sb.log}.100`; const recent = `${sb.log}.101`;
  fs.writeFileSync(old, 'interrupted'); fs.writeFileSync(recent, 'active');
  fs.utimesSync(old, 0, 0);
  sb.run();
  await waitFor(() => fs.existsSync(sb.log));
  assert.equal(fs.existsSync(old), false);
  assert.equal(fs.readFileSync(recent, 'utf8'), 'active');
});
