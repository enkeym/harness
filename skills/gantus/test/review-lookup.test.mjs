import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { apiFixture, boardFixture, initRepo, remote, runCli, task } from './helpers.mjs';

const source = 'feature/STR-12';

function resultOf(result) {
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test('review lookup reads one card by the source branch without ownership, comments or review gates', async (t) => {
  const cwd = initRepo(t, { branch: 'dev' });
  const tasks = [task(12, {
    assignee: 'emp-2',
    creatorUserId: 8,
    name: 'STR-99 не ключ заголовка',
    desc: 'Требования карточки'
  })];
  const board = boardFixture(tasks);
  const api = await apiFixture(t, { tasks, board, comments: false });

  const result = resultOf(await api.run(['review-lookup', '--branch', source], {
    cwd, env: { GANTUS_GIT_REMOTE: remote }
  }));

  assert.equal(result.configured, true);
  assert.equal(result.applicable, true);
  assert.equal(result.found, true);
  assert.equal(result.taskKey, 'STR-12');
  assert.equal(result.card.id, '12');
  assert.equal(result.card.desc, 'Требования карточки');
  assert.equal(result.card.assignee, 'emp-2');
  const sha = (value) => createHash('sha256').update(value, 'utf8').digest('hex');
  assert.equal(result.card.nameSha256, sha('STR-99 не ключ заголовка'));
  assert.equal(result.card.descSha256, sha('Требования карточки'));
  assert.equal('review' in result, false);
  assert.deepEqual(api.writes(), []);
});

test('review lookup sends no board request for a foreign repository or a non-unique key', async (t) => {
  const foreignCwd = initRepo(t, {
    branch: 'dev', upstream: 'https://git.example.invalid/other/repo.git'
  });
  const foreign = await apiFixture(t, {
    tasks: [task(12, { assignee: 'emp-1' })],
    board: boardFixture([task(12, { assignee: 'emp-1' })])
  });
  const mismatch = resultOf(await foreign.run(['review-lookup', '--branch', source], {
    cwd: foreignCwd, env: { GANTUS_GIT_REMOTE: remote }
  }));
  assert.equal(mismatch.applicable, false);
  assert.equal(mismatch.reason, 'remote-mismatch');
  assert.deepEqual(foreign.server.requests, []);

  for (const branch of ['feature/no-key', 'feature/STR-12-STR-13']) {
    const cwd = initRepo(t, { branch: 'dev' });
    const api = await apiFixture(t, {
      tasks: [task(12, { assignee: 'emp-1' })],
      board: boardFixture([task(12, { assignee: 'emp-1' })])
    });
    const result = resultOf(await api.run(['review-lookup', '--branch', branch], {
      cwd, env: { GANTUS_GIT_REMOTE: remote }
    }));
    assert.equal(result.found, false);
    assert.equal(result.reason, branch === 'feature/no-key' ? 'no-key' : 'several-keys');
    assert.deepEqual(api.server.requests, []);
  }
});

test('review lookup reports a missing or ambiguous card without writing', async (t) => {
  const cases = [
    [[task(99, { assignee: 'emp-1' })], 'no-card'],
    [[task(12, { assignee: 'emp-1' }), task(99, { taskKey: 'STR-12', assignee: 'emp-1' })], 'several-cards']
  ];
  for (const [tasks, reason] of cases) {
    const cwd = initRepo(t, { branch: 'dev' });
    const api = await apiFixture(t, { tasks, board: boardFixture(tasks) });

    const result = resultOf(await api.run(['review-lookup', '--branch', source], {
      cwd, env: { GANTUS_GIT_REMOTE: remote }
    }));

    assert.equal(result.found, false);
    assert.equal(result.reason, reason);
    assert.deepEqual(api.writes(), []);
  }
});

test('review lookup ignores a key that exists only in the task title and makes no board request', async (t) => {
  const cwd = initRepo(t, { branch: 'dev' });
  const tasks = [task(99, { assignee: 'emp-1', name: 'STR-99 только в заголовке' })];
  const api = await apiFixture(t, { tasks, board: boardFixture(tasks) });

  const result = resultOf(await api.run(['review-lookup', '--branch', 'feature/export'], {
    cwd, env: { GANTUS_GIT_REMOTE: remote }
  }));

  assert.equal(result.found, false);
  assert.equal(result.reason, 'no-key');
  assert.deepEqual(api.server.requests, []);
});

test('review lookup fails before board data when the authenticated account differs', async (t) => {
  const cwd = initRepo(t, { branch: 'dev' });
  const tasks = [task(12, { assignee: 'emp-1' })];
  const api = await apiFixture(t, {
    tasks,
    board: boardFixture(tasks),
    identity: { id: '99', employeeId: 'emp-9' }
  });

  const result = await api.run(['review-lookup', '--branch', source], {
    cwd, env: { GANTUS_GIT_REMOTE: remote }
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /учётная запись не совпадает/);
  assert.deepEqual(api.server.requests.map(({ url }) => url), ['/api/auth/me']);
  assert.deepEqual(api.writes(), []);
});

test('review lookup reports a broken active configuration separately from an absent one', async (t) => {
  const cwd = initRepo(t, { branch: 'dev' });
  const broken = await runCli(['review-lookup', '--branch', source], {
    cwd,
    env: {
      GANTUS_BASE_URL: '::not-a-url',
      GANTUS_TEAM_ID: 'team-1',
      GANTUS_SESSION_COOKIE: 'session',
      GANTUS_USER_ID: '7',
      GANTUS_GIT_REMOTE: remote
    }
  });

  assert.equal(broken.status, 2);
  assert.match(broken.stderr, /GANTUS_BASE_URL: некорректный URL/);
});

test('review lookup stays absent without the base configuration and does not need the local branch', async (t) => {
  const cwd = initRepo(t, { branch: 'dev' });
  const absent = await runCli(['review-lookup', '--branch', source], {
    cwd, env: { GANTUS_GIT_REMOTE: remote }
  });
  assert.equal(absent.status, 0, absent.stderr);
  assert.deepEqual(JSON.parse(absent.stdout), { configured: false });
});
