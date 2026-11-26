import assert from 'node:assert/strict';
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
      : options.getMr;
    return sendJson(res, 200, value);
  });
  const cwd = initRepo(t, {
    branch: 'unrelated-local-work',
    upstream: `${fixture.url}/group/repo.git`
  });
  const api = await apiFixture(t, {
    tasks: options.tasks,
    board: options.board,
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
    'gitlab-user-id': '7'
  };
  const run = (overrides = {}) => api.run([
    'post-merge',
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
  return { fixture, api, cwd, run };
}

function resultOf(result) {
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

function assertReadOnly(context) {
  assert.deepEqual(context.api.writes(), []);
  assert.ok(context.fixture.requests.every((request) => request.method === 'GET'));
}

test('post-merge verifies merged state by GET and reports the actual review column without a write', async (t) => {
  const tasks = [task(12, { kanbanColumnId: 'col-review', status: 'review', kanbanOrder: 2 })];
  const context = await setup(t, {
    tasks,
    board: boardFixture(tasks),
    getMr: (fixture) => mergedMr(fixture)
  });

  const result = resultOf(await context.run());

  assert.deepEqual(result, {
    merged: true,
    taskKey: key,
    mr: { iid: '5', sha: headSha },
    card: { id: '12', columnId: 'col-review', column: 'На ревью', status: 'review' }
  });
  assertReadOnly(context);
});

test('post-merge never patches a review card or rolls back a testing and later column', async (t) => {
  for (const [columnId, status, name] of [
    ['col-review', 'review', 'На ревью'],
    ['col-testing', 'testing', 'Тестирование'],
    ['col-done', 'done', 'Готово']
  ]) {
    const tasks = [task(12, { kanbanColumnId: columnId, status })];
    const context = await setup(t, {
      tasks,
      board: boardFixture(tasks),
      getMr: (fixture) => mergedMr(fixture)
    });

    const result = resultOf(await context.run());

    assert.deepEqual(result.card, { id: '12', columnId, column: name, status });
    assertReadOnly(context);
  }
});

test('post-merge accepts only an authoritative merged GET and never trusts a local receipt', async (t) => {
  const variants = [
    { state: 'opened' },
    { draft: true },
    { source_branch: 'feature/STR-99' },
    { target_branch: 'main' },
    { project_id: 41 },
    { source_project_id: 41 },
    { project_id: 41, source_project_id: 41, target_project_id: 41 },
    { sha: 'e'.repeat(40) },
    { diff_refs: { base_sha: baseSha, start_sha: startSha, head_sha: 'e'.repeat(40) } },
    { merged_at: null },
    { merge_user: { id: 8 } },
    { web_url: 'http://127.0.0.1:1/group/repo/-/merge_requests/6' }
  ];
  for (const override of variants) {
    const context = await setup(t, {
      tasks: [task(12, { kanbanColumnId: 'col-review', status: 'review' })],
      getMr: (fixture) => mergedMr(fixture, override)
    });

    const result = await context.run();

    assert.equal(result.status, 1, JSON.stringify(override));
    assertReadOnly(context);
  }

  const plain = await setup(t, {
    tasks: [task(12, { kanbanColumnId: 'col-review', status: 'review' })],
    getMr: (fixture) => mergedMr(fixture)
  });
  const spoofed = await plain.run({ mr: JSON.stringify({ state: 'merged', iid: 5 }) });
  assert.equal(spoofed.status, 2);
  assert.match(spoofed.stderr, /не принимает/);
});

test('post-merge pins the card id and key without any write', async (t) => {
  const wrong = await setup(t, {
    tasks: [task(12, { kanbanColumnId: 'col-review', status: 'review' })],
    getMr: (fixture) => mergedMr(fixture)
  });
  const cardResult = await wrong.run({ 'card-id': '99' });
  assert.equal(cardResult.status, 1);
  assert.match(cardResult.stderr, /не совпадает/);
  assertReadOnly(wrong);

  const duplicated = await setup(t, {
    tasks: [task(12, { kanbanColumnId: 'col-review', status: 'review' }), task(123, { taskKey: 'STR-12' })],
    getMr: (fixture) => mergedMr(fixture)
  });
  const keyResult = await duplicated.run();
  assert.equal(keyResult.status, 1);
  assert.match(keyResult.stderr, /несколько/);
  assertReadOnly(duplicated);
});
