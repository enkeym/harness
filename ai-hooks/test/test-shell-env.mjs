import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { installShell } from '../../bin/shell-install.mjs';
import { apiFixture, boardFixture, initRepo, remote, startServer, task } from '../../skills/gantus/test/helpers.mjs';

const repo = path.resolve(import.meta.dirname, '../..');
const gantusCli = path.join(repo, 'skills/gantus/scripts/gantus.mjs');

function sandbox(t) {
  t.mock.method(console, 'error', () => {});
  t.mock.method(console, 'log', () => {});
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-shell-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  fs.mkdirSync(path.join(home, '.config/harness'), { recursive: true });
  fs.symlinkSync(path.join(repo, 'shell/harness.bash'), path.join(home, '.config/harness/bashrc'));
  assert.equal(installShell(home, false, { SHELL: '/bin/bash' }), 0);
  return home;
}

function settings(home, text) {
  fs.writeFileSync(path.join(home, '.config/harness/env'), text);
}

function runBash(home, script, cwd = home) {
  return new Promise((resolve) => {
    const child = spawn('bash', ['-c', script, 'bash', process.execPath, gantusCli], {
      cwd,
      env: { PATH: process.env.PATH, HOME: home }
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), 20000);
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('close', (status, signal) => {
      clearTimeout(timer);
      resolve({ status, signal, stdout, stderr });
    });
  });
}

function allexportScript(before) {
  return `${before}. "$HOME/.bashrc"\ncase $- in *a*) printf 'allexport=on\\n' ;; *) printf 'allexport=off\\n' ;; esac\n`;
}

test('bash bootstrap exports unexported harness env for review lookup without writes', async (t) => {
  const home = sandbox(t);
  const cwd = initRepo(t, { branch: 'dev' });
  const tasks = [task(12, { name: 'Требования карточки', desc: 'Описание карточки' })];
  const api = await apiFixture(t, { tasks, board: boardFixture(tasks) });
  settings(home, [
    `GANTUS_BASE_URL=${api.server.url}`,
    'GANTUS_TEAM_ID=team-1',
    'GANTUS_SESSION_COOKIE=session=test-cookie',
    'GANTUS_USER_ID=7',
    `GANTUS_GIT_REMOTE=${remote}`,
    ''
  ].join('\n'));

  const result = await runBash(home, '. "$HOME/.bashrc"\n"$1" "$2" review-lookup --branch feature/STR-12\n', cwd);

  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.configured, true);
  assert.equal(output.applicable, true);
  assert.equal(output.found, true);
  assert.equal(output.taskKey, 'STR-12');
  assert.equal(output.card.id, '12');
  assert.ok(api.server.requests.length > 0);
  assert.deepEqual(api.server.requests.map(({ method }) => method).filter((method) => method !== 'GET'), []);
  assert.deepEqual(api.writes(), []);
});

test('bash bootstrap leaves review lookup unconfigured without required settings or env file', async (t) => {
  const server = await startServer((req, res) => {
    res.writeHead(500);
    res.end();
  });
  t.after(() => server.close());

  for (const text of [undefined, `GANTUS_GIT_REMOTE=${remote}\n`]) {
    const home = sandbox(t);
    if (text !== undefined) settings(home, text);

    const result = await runBash(home, '. "$HOME/.bashrc"\n"$1" "$2" review-lookup --branch feature/STR-12\n');

    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), { configured: false });
    assert.deepEqual(server.requests, []);
  }
});

test('bash bootstrap reports a partial harness env by setting name without secrets or requests', async (t) => {
  const home = sandbox(t);
  const server = await startServer((req, res) => {
    res.writeHead(500);
    res.end();
  });
  t.after(() => server.close());
  settings(home, [
    `GANTUS_BASE_URL=${server.url}`,
    'GANTUS_SESSION_COOKIE=session=super-secret',
    ''
  ].join('\n'));

  const result = await runBash(home, '. "$HOME/.bashrc"\n"$1" "$2" review-lookup --branch feature/STR-12\n');

  assert.equal(result.status, 2);
  assert.match(result.stderr, /не настроено: GANTUS_TEAM_ID/);
  assert.equal(result.stderr.includes('super-secret'), false);
  assert.deepEqual(server.requests, []);
});

test('bash bootstrap keeps the previous allexport state around the sourced env', async (t) => {
  const defaultHome = sandbox(t);
  settings(defaultHome, 'HARNESS_TEST_SETTING=value\n');
  const defaultResult = await runBash(defaultHome, allexportScript(''));
  assert.equal(defaultResult.status, 0, defaultResult.stderr);
  assert.match(defaultResult.stdout, /allexport=off/);

  const presetHome = sandbox(t);
  settings(presetHome, 'HARNESS_TEST_SETTING=value\n');
  const presetResult = await runBash(presetHome, allexportScript('set -a\n'));
  assert.equal(presetResult.status, 0, presetResult.stderr);
  assert.match(presetResult.stdout, /allexport=on/);
});
