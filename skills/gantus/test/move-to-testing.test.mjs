import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import {
  apiFixture, boardFixture, gitlabServer, initRepo, sendJson, task
} from './helpers.mjs';

const headSha = 'a'.repeat(40);
const baseSha = 'c'.repeat(40);
const startSha = 'd'.repeat(40);
const mergeSha = 'b'.repeat(40);
const key = 'STR-12';
const sourceBranch = 'feature/STR-12';
const targetBranch = 'dev';
const repoEnv = {
  GANTUS_REVIEW_COLUMN_ID: 'col-review',
  GANTUS_REVIEW_FROM_COLUMN_IDS: 'col-todo,col-progress',
  GANTUS_TESTING_COLUMN_ID: 'col-testing'
};
const nameSha256 = createHash('sha256').update('Задача 12').digest('hex');
const descSha256 = createHash('sha256').update('').digest('hex');

function mrUrl(fixture) {
  return `https://${fixture.host}/group/repo/-/merge_requests/5`;
}

function mergedMr(fixture, overrides = {}) {
  return {
    iid: 5,
    project_id: 42,
    source_project_id: 42,
    target_project_id: 42,
    web_url: mrUrl(fixture),
    state: 'merged',
    draft: false,
    merged_at: '2026-11-26T10:00:00Z',
    source_branch: sourceBranch,
    target_branch: targetBranch,
    sha: headSha,
    diff_refs: { base_sha: baseSha, start_sha: startSha, head_sha: headSha },
    merge_commit_sha: mergeSha,
    merge_user: { id: 7 },
    ...overrides
  };
}

async function setup(t, options = {}) {
  const fixture = await gitlabServer(t, async (req, res) => {
    const url = new URL(req.url, 'http://fixture');
    const match = /^\/api\/v4\/projects\/([^/]+)\/merge_requests\/(\d+)$/.exec(url.pathname);
    if (req.method !== 'GET' || !match) return sendJson(res, 404, {});
    const value = typeof options.getMr === 'function'
      ? options.getMr(fixture)
      : (options.getMr ?? mergedMr(fixture));
    return sendJson(res, 200, value);
  }, { user: options.gitlabUser });
  const tasks = options.tasks ?? [
    task(12, { kanbanColumnId: 'col-review', kanbanOrder: 2, assignee: 'emp-2' }),
    task(123, { kanbanColumnId: 'col-testing', kanbanOrder: 1 })
  ];
  const cwd = initRepo(t, {
    branch: 'unrelated-local-work',
    upstream: `${fixture.url}/group/repo.git`
  });
  const api = await apiFixture(t, {
    identity: options.identity,
    tasks,
    board: options.board ?? boardFixture(tasks),
    autoWrite: options.autoWrite,
    write: options.write
  });
  const defaults = {
    'mr-url': mrUrl(fixture),
    'project-id': '42',
    'key': key,
    'card-id': '12',
    'source-branch': sourceBranch,
    'expected-target-branch': targetBranch,
    'expected-sha': headSha,
    'gitlab-user-id': '7',
    'name-sha256': nameSha256,
    'desc-sha256': descSha256
  };
  const run = (overrides = {}) => api.run([
    'move-to-testing',
    ...Object.entries({ ...defaults, ...overrides }).flatMap(([name, value]) => [`--${name}`, value])
  ], {
    cwd,
    env: {
      GANTUS_GIT_REMOTE: `${fixture.url}/group/repo.git`,
      PATH: fixture.env.PATH,
      ...repoEnv,
      ...(options.env ?? {})
    }
  });
  return { fixture, api, tasks, cwd, run };
}

function assertReadOnlyGitlab(context) {
  assert.ok(context.fixture.requests.every((request) => request.method === 'GET'));
}

function assertNoPatch(context) {
  assert.deepEqual(context.api.writes(), []);
}

test('an explicit recovery moves a merged review card to testing with one PATCH and no GitLab write', async (t) => {
  const context = await setup(t);

  const result = await context.run();

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    merged: true,
    taskKey: key,
    mr: { iid: '5', sha: headSha },
    testMove: { moved: true, columnId: 'col-testing' }
  });
  assert.deepEqual(context.api.writes().map(({ method, url, body }) => [method, url, JSON.parse(body)]), [
    ['PATCH', '/api/kanban/cards/12', {
      columnId: 'col-testing', orderedIds: ['123', '12']
    }]
  ]);
  assertReadOnlyGitlab(context);
});

test('a card already in testing is a no-op', async (t) => {
  const tasks = [task(12, { kanbanColumnId: 'col-testing', kanbanOrder: 2 })];
  const context = await setup(t, { tasks });

  const result = await context.run();

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout).testMove, {
    moved: false, reason: 'already', columnId: 'col-testing'
  });
  assertNoPatch(context);
  assertReadOnlyGitlab(context);
});

test('the recovery preserves the foreign testing order observed at move time', async (t) => {
  const tasks = [
    task(12, { kanbanColumnId: 'col-review', kanbanOrder: 4 }),
    task(123, { kanbanColumnId: 'col-testing', kanbanOrder: 3 }),
    task(124, { kanbanColumnId: 'col-testing', kanbanOrder: 1 }),
    task(125, { kanbanColumnId: 'col-testing', kanbanOrder: 2 })
  ];
  const context = await setup(t, { tasks });

  const result = await context.run();

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(context.api.writes().map(({ method, url, body }) => [method, url, JSON.parse(body)]), [
    ['PATCH', '/api/kanban/cards/12', {
      columnId: 'col-testing', orderedIds: ['124', '125', '123', '12']
    }]
  ]);
  assertReadOnlyGitlab(context);
});

test('a second explicit call after the move is a no-op with no second PATCH', async (t) => {
  const context = await setup(t);

  const first = await context.run();
  const second = await context.run();

  assert.equal(first.status, 0, first.stderr);
  assert.equal(second.status, 0, second.stderr);
  assert.deepEqual(JSON.parse(first.stdout).testMove, { moved: true, columnId: 'col-testing' });
  assert.deepEqual(JSON.parse(second.stdout).testMove, {
    moved: false, reason: 'already', columnId: 'col-testing'
  });
  assert.equal(context.api.writes().length, 1);
  assertReadOnlyGitlab(context);
});

test('card, digest and ACL drift block before any PATCH', async (t) => {
  const variants = [
    { run: { 'name-sha256': 'f'.repeat(64) } },
    { run: { 'card-id': '99' } },
    { tasks: [task(12, { kanbanColumnId: 'col-todo', kanbanOrder: 2 })] },
    {
      tasks: [task(12, {
        kanbanColumnId: 'col-review', kanbanOrder: 2, editProtected: true,
        creatorUserId: 8, assignee: 'emp-2'
      })]
    }
  ];
  for (const variant of variants) {
    const context = await setup(t, { tasks: variant.tasks });

    const result = await context.run(variant.run);

    assert.equal(result.status, 1, JSON.stringify(variant));
    assertNoPatch(context);
    assertReadOnlyGitlab(context);
  }
});

test('an invalid or mismatched merged MR or GitLab user blocks before any PATCH', async (t) => {
  const variants = [
    { getMr: (fixture) => mergedMr(fixture, { state: 'opened' }) },
    { getMr: (fixture) => mergedMr(fixture, { sha: 'e'.repeat(40) }) },
    { getMr: (fixture) => mergedMr(fixture, { merge_user: { id: 8 } }) },
    { getMr: (fixture) => mergedMr(fixture, { merge_user: null }) },
    { getMr: (fixture) => mergedMr(fixture, { merge_user: undefined }) },
    { getMr: (fixture) => mergedMr(fixture, { target_branch: 'main' }) },
    { getMr: (fixture) => mergedMr(fixture, { project_id: 41 }) },
    { gitlabUser: { id: 8 } },
    { gitlabUser: { id: null } }
  ];
  for (const variant of variants) {
    const context = await setup(t, variant);

    const result = await context.run(variant.run);

    assert.equal(result.status, 1, JSON.stringify(variant));
    assertNoPatch(context);
    assertReadOnlyGitlab(context);
  }

  const foreign = await setup(t);
  const foreignResult = await foreign.run({
    'mr-url': `https://${foreign.fixture.host}/other/repo/-/merge_requests/5`
  });
  assert.equal(foreignResult.status, 1);
  assertNoPatch(foreign);
  assertReadOnlyGitlab(foreign);
});

test('a definite PATCH rejection is reported once without a retry', async (t) => {
  const context = await setup(t, {
    write: () => [409, { message: 'conflict' }]
  });

  const result = await context.run();

  assert.equal(result.status, 1);
  assert.match(result.stderr, /409/);
  assert.equal(context.api.writes().length, 1);
  assert.equal(context.api.writes()[0].method, 'PATCH');
  assertReadOnlyGitlab(context);
});

test('an unknown PATCH outcome is reported as unknown once without a retry', async (t) => {
  const context = await setup(t, {
    write: () => [500, { message: 'server error' }]
  });

  const result = await context.run();

  assert.equal(result.status, 1);
  assert.match(result.stderr, /результат записи неизвестен/);
  assert.equal(context.api.writes().length, 1);
  assertReadOnlyGitlab(context);
});

test('an unconfirmed read-back after the PATCH is unknown and never repeated', async (t) => {
  const context = await setup(t, { autoWrite: false });

  const result = await context.run();

  assert.equal(result.status, 1);
  assert.match(result.stderr, /не подтверждено/);
  assert.equal(context.api.writes().length, 1);
  assertReadOnlyGitlab(context);
});

test('ACL lost between the route check and the move blocks before the PATCH', async (t) => {
  const tasks = [
    task(12, {
      kanbanColumnId: 'col-review', kanbanOrder: 2, editProtected: true,
      creatorUserId: 7, assignee: 'emp-1'
    }),
    task(123, { kanbanColumnId: 'col-testing', kanbanOrder: 1 })
  ];
  let boardReads = 0;
  const context = await setup(t, {
    tasks,
    board: () => {
      boardReads += 1;
      if (boardReads >= 1) {
        tasks[0].creatorUserId = 8;
        tasks[0].assignee = 'emp-2';
      }
      return boardFixture(tasks);
    }
  });

  const result = await context.run();

  assert.equal(result.status, 1);
  assert.match(result.stderr, /правка недоступна|принадлежит/);
  assertNoPatch(context);
  assertReadOnlyGitlab(context);
});

test('a duplicated key blocks before any GitLab or board write', async (t) => {
  const tasks = [
    task(12, { kanbanColumnId: 'col-review', kanbanOrder: 2 }),
    task(123, { kanbanColumnId: 'col-testing', kanbanOrder: 1, taskKey: key })
  ];
  const context = await setup(t, { tasks });

  const result = await context.run();

  assert.equal(result.status, 1);
  assert.match(result.stderr, /несколько/);
  assertNoPatch(context);
  assertReadOnlyGitlab(context);
});
