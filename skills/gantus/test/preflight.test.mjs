import assert from 'node:assert/strict';
import { test } from 'node:test';
import { apiFixture, boardFixture, initRepo, remote, runCli, task } from './helpers.mjs';

const source = 'feature/STR-12';

function resultOf(result) {
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test('preflight is absent without the base configuration and rejects a partial one', async (t) => {
  const cwd = initRepo(t, { branch: source });
  for (const env of [{}, { GANTUS_GIT_REMOTE: remote }]) {
    const absent = await runCli(['preflight', '--key', 'STR-12'], { cwd, env });
    assert.equal(absent.status, 0, absent.stderr);
    assert.deepEqual(JSON.parse(absent.stdout), { configured: false });
  }

  const partial = await runCli(['preflight', '--key', 'STR-12'], {
    cwd, env: { GANTUS_BASE_URL: 'https://gantus.example.invalid' }
  });
  assert.equal(partial.status, 2);
  assert.match(partial.stderr, /GANTUS_TEAM_ID/);
});

test('preflight separates a foreign repository from an applicable project without board access', async (t) => {
  const foreignCwd = initRepo(t, {
    branch: source, upstream: 'https://git.example.invalid/other/repo.git'
  });
  const foreign = await apiFixture(t, {
    tasks: [task(12, { assignee: 'emp-1' })],
    board: boardFixture([task(12, { assignee: 'emp-1' })])
  });
  const skipped = resultOf(await foreign.run(['preflight', '--key', 'STR-12'], {
    cwd: foreignCwd, env: { GANTUS_GIT_REMOTE: remote }
  }));
  assert.equal(skipped.applicable, false);
  assert.equal(skipped.reason, 'remote-mismatch');
  assert.deepEqual(foreign.server.requests, []);

  const unconfigured = await apiFixture(t, {
    tasks: [task(12, { assignee: 'emp-1' })],
    board: boardFixture([task(12, { assignee: 'emp-1' })])
  });
  const noRemote = resultOf(await unconfigured.run(['preflight', '--key', 'STR-12'], {
    cwd: foreignCwd
  }));
  assert.equal(noRemote.applicable, false);
  assert.equal(noRemote.reason, 'remote-not-configured');
  assert.deepEqual(unconfigured.server.requests, []);

});

test('preflight without --key stays absent or unrelated without exposing remotes', async (t) => {
  const cwd = initRepo(t, { branch: source });
  const absent = await runCli(['preflight'], { cwd });
  assert.equal(absent.status, 0, absent.stderr);
  assert.deepEqual(JSON.parse(absent.stdout), { configured: false });

  const invalid = await runCli(['preflight'], {
    cwd,
    env: {
      GANTUS_BASE_URL: 'https://gantus.example.invalid',
      GANTUS_TEAM_ID: 'team-1',
      GANTUS_SESSION_COOKIE: 'session=abc',
      GANTUS_USER_ID: '7',
      GANTUS_GIT_REMOTE: ' '
    }
  });
  assert.equal(invalid.status, 2);
  assert.match(invalid.stderr, /GANTUS_GIT_REMOTE/);

  const foreignCwd = initRepo(t, {
    branch: source, upstream: 'https://git.example.invalid/other/repo.git'
  });
  const foreign = await apiFixture(t, {
    tasks: [task(12, { assignee: 'emp-1' })],
    board: boardFixture([task(12, { assignee: 'emp-1' })])
  });
  const skipped = resultOf(await foreign.run(['preflight'], {
    cwd: foreignCwd,
    env: { GANTUS_GIT_REMOTE: 'https://user:secret@git.example.invalid/team/repo.git' }
  }));
  assert.equal(skipped.applicable, false);
  assert.equal(skipped.reason, 'remote-mismatch');
  assert.equal('expected' in skipped, false);
  assert.equal('actual' in skipped, false);
  assert.doesNotMatch(JSON.stringify(skipped), /user:secret|other\/repo|team\/repo/);
  assert.deepEqual(foreign.server.requests, []);
});

test('preflight without --key derives the branch key and gates a keyless matching repo', async (t) => {
  const keylessCwd = initRepo(t, { branch: 'feature/no-key' });
  const keyless = await apiFixture(t, {
    tasks: [task(12, { assignee: 'emp-1' })],
    board: boardFixture([task(12, { assignee: 'emp-1' })])
  });
  const needsLink = resultOf(await keyless.run(['preflight'], {
    cwd: keylessCwd, env: { GANTUS_GIT_REMOTE: remote }
  }));
  assert.equal(needsLink.configured, true);
  assert.equal(needsLink.applicable, true);
  assert.equal(needsLink.ready, false);
  assert.equal(needsLink.reason, 'no-key');
  assert.equal(needsLink.needsLink, true);
  assert.deepEqual(keyless.server.requests, []);

  const forced = await keyless.run(['preflight', '--key', 'STR-12'], {
    cwd: keylessCwd, env: { GANTUS_GIT_REMOTE: remote }
  });
  assert.equal(forced.status, 1);
  assert.match(forced.stderr, /нет ключа/);
  assert.deepEqual(keyless.server.requests, []);

  const keyedCwd = initRepo(t, { branch: source });
  const keyedTasks = [task(12, { assignee: 'emp-1' })];
  const keyed = await apiFixture(t, { tasks: keyedTasks, board: boardFixture(keyedTasks) });
  const ready = resultOf(await keyed.run(['preflight'], {
    cwd: keyedCwd, env: { GANTUS_GIT_REMOTE: remote }
  }));
  assert.equal(ready.ready, true);
  assert.equal(ready.taskKey, 'STR-12');
  assert.equal(ready.card.id, '12');
  assert.deepEqual(keyed.writes(), []);
});

test('preflight reads one own assigned card and writes nothing', async (t) => {
  const cwd = initRepo(t, { branch: source });
  const tasks = [task(12, { assignee: 'emp-1' })];
  const api = await apiFixture(t, { tasks, board: boardFixture(tasks) });

  const result = resultOf(await api.run(['preflight', '--key', 'STR-12'], {
    cwd,
    env: {
      GANTUS_GIT_REMOTE: remote,
      GANTUS_TESTING_COLUMN_ID: 'col-testing',
      GANTUS_TESTING_FROM_COLUMN_IDS: 'col-todo,col-review'
    }
  }));

  assert.equal(result.configured, true);
  assert.equal(result.applicable, true);
  assert.equal(result.ready, true);
  assert.equal(result.taskKey, 'STR-12');
  assert.equal(result.card.id, '12');
  assert.equal(result.card.columnId, 'col-todo');
  assert.equal(result.testing.planned, true);
  assert.equal(result.testing.columnId, 'col-testing');
  assert.deepEqual(api.writes(), []);
});

test('preflight blocks a foreign current assignee even for the former creator', async (t) => {
  const cwd = initRepo(t, { branch: source });
  const tasks = [task(12, { assignee: 'emp-2', creatorUserId: 7 })];
  const api = await apiFixture(t, { tasks, board: boardFixture(tasks) });

  const result = await api.run(['preflight', '--key', 'STR-12'], {
    cwd, env: { GANTUS_GIT_REMOTE: remote }
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /назначена/);
  assert.deepEqual(api.writes(), []);
});

test('preflight blocks an ambiguous key, card, branch or project before any write', async (t) => {
  const cases = [
    {
      branch: 'feature/STR-12-STR-13',
      tasks: [task(12, { assignee: 'emp-1' })],
      error: /несколько ключей/
    },
    {
      branch: 'feature/STR-99',
      tasks: [task(12, { assignee: 'emp-1' })],
      error: /не совпадает/
    },
    {
      branch: source,
      tasks: [task(12, { assignee: 'emp-1' }), task(99, { taskKey: 'STR-12', assignee: 'emp-1' })],
      error: /несколько карточек/
    },
    {
      branch: 'feature/STR-77',
      key: 'STR-77',
      tasks: [task(12, { assignee: 'emp-1' })],
      error: /не найдена/
    }
  ];
  for (const entry of cases) {
    const cwd = initRepo(t, { branch: entry.branch });
    const api = await apiFixture(t, {
      tasks: entry.tasks, board: boardFixture(entry.tasks)
    });
    const result = await api.run(['preflight', '--key', entry.key ?? 'STR-12'], {
      cwd, env: { GANTUS_GIT_REMOTE: remote }
    });

    assert.equal(result.status, 1);
    assert.match(result.stderr, entry.error);
    assert.deepEqual(api.writes(), []);
  }
});

test('preflight stops known fatal comment and testing-target reasons, but not a later source column', async (t) => {
  const cwd = initRepo(t, { branch: source });
  const testingEnv = {
    GANTUS_GIT_REMOTE: remote,
    GANTUS_TESTING_COLUMN_ID: 'col-testing',
    GANTUS_TESTING_FROM_COLUMN_IDS: 'col-todo,col-review'
  };

  const disabledTasks = [task(12, { assignee: 'emp-1' })];
  const disabled = await apiFixture(t, {
    tasks: disabledTasks, board: boardFixture(disabledTasks), comments: false
  });
  const comments = await disabled.run(['preflight', '--key', 'STR-12'], {
    cwd, env: testingEnv
  });
  assert.equal(comments.status, 1);
  assert.match(comments.stderr, /комментарии отключены/);
  assert.deepEqual(disabled.writes(), []);

  const unknownTasks = [task(12, { assignee: 'emp-1' })];
  const unknown = await apiFixture(t, {
    tasks: unknownTasks, board: boardFixture(unknownTasks)
  });
  const target = await unknown.run(['preflight', '--key', 'STR-12'], {
    cwd, env: { ...testingEnv, GANTUS_TESTING_COLUMN_ID: 'col-unknown' }
  });
  assert.equal(target.status, 1);
  assert.match(target.stderr, /колонка тестирования не найдена/);
  assert.deepEqual(unknown.writes(), []);

  const laterTasks = [task(12, { assignee: 'emp-1', kanbanColumnId: 'col-done' })];
  const later = await apiFixture(t, {
    tasks: laterTasks, board: boardFixture(laterTasks)
  });
  const blocked = resultOf(await later.run(['preflight', '--key', 'STR-12'], {
    cwd, env: testingEnv
  }));
  assert.equal(blocked.ready, true);
  assert.equal(blocked.testing.planned, false);
  assert.equal(blocked.testing.reason, 'source-not-allowed');
  assert.equal(blocked.testing.columnId, 'col-done');
  assert.deepEqual(later.writes(), []);
});
