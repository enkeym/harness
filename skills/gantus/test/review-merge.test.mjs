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
const resolved = [{ id: 'd1', notes: [{ resolvable: true, resolved: true }] }];
const nameSha256 = createHash('sha256').update('Задача 12').digest('hex');
const descSha256 = createHash('sha256').update('').digest('hex');

function mrUrl(fixture) {
  return `https://${fixture.host}/group/repo/-/merge_requests/5`;
}

function openMr(fixture, overrides = {}) {
  return {
    iid: 5,
    project_id: 42,
    source_project_id: 42,
    target_project_id: 42,
    web_url: mrUrl(fixture),
    state: 'opened',
    draft: false,
    source_branch: sourceBranch,
    target_branch: targetBranch,
    diff_refs: { base_sha: baseSha, start_sha: startSha, head_sha: headSha },
    detailed_merge_status: 'mergeable',
    blocking_discussions_resolved: true,
    has_conflicts: false,
    force_remove_source_branch: false,
    merge_commit_sha: null,
    ...overrides
  };
}

function mergedMr(fixture, overrides = {}) {
  return openMr(fixture, {
    state: 'merged',
    merged_at: '2026-11-26T10:00:00Z',
    merge_commit_sha: mergeSha,
    merge_user: { id: 7 },
    ...overrides
  });
}

async function setup(t, options = {}) {
  const state = { reads: 0, merges: 0 };
  const fixture = await gitlabServer(t, async (req, res) => {
    const url = new URL(req.url, 'http://fixture');
    const match = /^\/api\/v4\/projects\/([^/]+)\/merge_requests\/(\d+)(\/discussions|\/merge)?$/.exec(url.pathname);
    if (!match) return sendJson(res, 404, {});
    if (req.method === 'GET' && !match[3]) {
      state.reads += 1;
      const value = typeof options.mr === 'function'
        ? options.mr({ fixture, reads: state.reads, merges: state.merges })
        : (options.mr ?? openMr(fixture));
      return sendJson(res, 200, value);
    }
    if (req.method === 'GET' && match[3] === '/discussions') {
      const page = Number(url.searchParams.get('page') ?? '1');
      const batch = typeof options.discussions === 'function'
        ? options.discussions(page)
        : ((options.discussions ?? [resolved])[page - 1] ?? []);
      return sendJson(res, 200, batch);
    }
    if (req.method === 'PUT' && match[3] === '/merge') {
      state.merges += 1;
      if (options.destroyMerge) {
        res.destroy();
        return undefined;
      }
      const reply = typeof options.merge === 'function'
        ? options.merge({ fixture, merges: state.merges })
        : [200, mergedMr(fixture)];
      return sendJson(res, ...reply);
    }
    return sendJson(res, 404, {});
  });
  const tasks = options.tasks ?? [
    task(12, { kanbanColumnId: 'col-review', kanbanOrder: 2, assignee: 'emp-2' }),
    task(123, { kanbanColumnId: 'col-testing', kanbanOrder: 1 })
  ];
  const cwd = initRepo(t, {
    branch: 'unrelated-local-work',
    upstream: `${fixture.url}/group/repo.git`
  });
  const api = await apiFixture(t, {
    tasks,
    board: options.board ?? boardFixture(tasks),
    autoWrite: options.autoWrite,
    write: options.write
  });
  const run = () => api.run([
    'review-merge', '--mr-url', mrUrl(fixture), '--project-id', '42', '--key', key,
    '--card-id', '12',
    '--source-branch', sourceBranch, '--target-branch', targetBranch,
    '--base-sha', baseSha, '--start-sha', startSha, '--head-sha', headSha,
    '--gitlab-user-id', '7', '--name-sha256', nameSha256, '--desc-sha256', descSha256
  ], {
    cwd,
    env: {
      GANTUS_GIT_REMOTE: `${fixture.url}/group/repo.git`,
      PATH: fixture.env.PATH,
      ...repoEnv,
      ...(options.env ?? {})
    }
  });
  return { fixture, api, state, cwd, run };
}

function writes(api) {
  return api.writes();
}

test('a clean MR merges once after board, discussions and GET, then moves review to testing', async (t) => {
  const context = await setup(t);

  const result = await context.run();

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    merged: true,
    taskKey: key,
    mr: { iid: '5', sha: headSha },
    testMove: { moved: true, columnId: 'col-testing' }
  });
  assert.deepEqual(writes(context.api).map(({ method, url, body }) => [method, url, JSON.parse(body)]), [
    ['PATCH', '/api/kanban/cards/12', {
      columnId: 'col-testing', orderedIds: ['123', '12']
    }]
  ]);
  const gitlabWrites = context.fixture.requests.filter((request) => request.method !== 'GET');
  assert.equal(gitlabWrites.length, 1);
  assert.equal(gitlabWrites[0].method, 'PUT');
  assert.deepEqual(JSON.parse(gitlabWrites[0].body), {
    sha: headSha, should_remove_source_branch: false
  });
  assert.ok(context.fixture.requests.every((request) => !/notes|draft_notes/.test(request.url)));
  assert.ok(!context.fixture.requests.some((request) => request.method === 'POST'));
});

test('merge is blocked on a changed revision, Draft, fork, conflicts, policy or checks', async (t) => {
  const variants = [
    { diff_refs: { base_sha: baseSha, start_sha: startSha, head_sha: 'e'.repeat(40) } },
    { diff_refs: { base_sha: 'e'.repeat(40), start_sha: startSha, head_sha: headSha } },
    { diff_refs: { base_sha: baseSha, start_sha: 'e'.repeat(40), head_sha: headSha } },
    { draft: true },
    { source_project_id: 41 },
    { target_branch: 'main' },
    { state: 'closed' },
    { detailed_merge_status: 'ci_still_running' },
    { blocking_discussions_resolved: false },
    { has_conflicts: true },
    { force_remove_source_branch: true },
    { diff_refs: null }
  ];
  for (const override of variants) {
    const context = await setup(t, {
      mr: (args) => openMr(args.fixture, override)
    });

    const result = await context.run();

    assert.equal(result.status, 1, JSON.stringify(override));
    assert.deepEqual(writes(context.api), [], JSON.stringify(override));
    assert.ok(!context.fixture.requests.some((request) => request.method === 'PUT'));
  }
});

test('every discussion page is read and any unresolved or malformed note blocks the merge', async (t) => {
  const fullPage = Array.from({ length: 100 }, (_, index) => ({
    id: `d${index}`, notes: [{ resolvable: true, resolved: true }]
  }));
  const blockingPages = [
    [{ id: 'late', notes: [{ resolvable: true, resolved: false }] }],
    [{ id: 'bad', notes: [{ resolved: true }] }],
    [{ id: 'bad', notes: [{ resolvable: true }] }],
    [{ id: 'bad', notes: null }],
    [{ id: 'bad', notes: [] }]
  ];
  for (const blocking of blockingPages) {
    const context = await setup(t, {
      discussions: (page) => (page === 1 ? blocking : [])
    });

    const pageOne = await context.run();
    assert.equal(pageOne.status, 1, JSON.stringify(blocking));
    assert.deepEqual(writes(context.api), []);
    assert.ok(!context.fixture.requests.some((request) => request.method === 'PUT'));

    const paged = await setup(t, {
      discussions: (page) => (page === 1 ? fullPage : blocking)
    });
    const pageTwo = await paged.run();
    assert.equal(pageTwo.status, 1);
    assert.equal(
      paged.fixture.requests.filter((request) => request.url.includes('/discussions')).length,
      2
    );
    assert.deepEqual(writes(paged.api), []);
    assert.ok(!paged.fixture.requests.some((request) => request.method === 'PUT'));
  }
});

test('standalone non-resolvable notes are read by the reviewer and do not block', async (t) => {
  const context = await setup(t, {
    discussions: [[
      { id: 'd1', notes: [{ resolvable: true, resolved: true }] },
      { id: 'd2', notes: [{ resolvable: false, resolved: null, system: false }] }
    ]]
  });

  const result = await context.run();

  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).merged, true);
  assert.equal(context.fixture.requests.filter((request) => request.method === 'PUT').length, 1);
});

test('board permissions and the reviewed route are checked before the irreversible merge', async (t) => {
  const cases = [
    { tasks: [task(12, { kanbanColumnId: 'col-review', editProtected: true })] },
    { tasks: [task(12, { kanbanColumnId: 'col-done' })] },
    { tasks: [task(12, { kanbanColumnId: 'col-review', name: 'Изменённые требования' })] },
    { tasks: [task(12, { kanbanColumnId: 'col-todo' })] }
  ];
  for (const options of cases) {
    const context = await setup(t, options);

    const result = await context.run();

    assert.equal(result.status, 1, JSON.stringify(options));
    assert.deepEqual(context.fixture.requests, []);
    assert.deepEqual(writes(context.api), []);
  }

  const doneBoard = boardFixture([task(12, { kanbanColumnId: 'col-review' })]);
  doneBoard.columns.find((column) => column.id === 'col-testing').status = 'done';
  const done = await setup(t, { board: doneBoard });
  assert.equal((await done.run()).status, 1);
  assert.deepEqual(done.fixture.requests, []);

  const same = await setup(t, {
    tasks: [task(12, { kanbanColumnId: 'col-review' })],
    env: { GANTUS_TESTING_COLUMN_ID: 'col-review' }
  });
  assert.equal((await same.run()).status, 1);
  assert.deepEqual(same.fixture.requests, []);
});

test('a 2xx merge response without merged proof is reconciled by one authoritative GET', async (t) => {
  const context = await setup(t, {
    mr: ({ fixture, merges }) => (merges === 0 ? openMr(fixture) : mergedMr(fixture)),
    merge: () => [200, {}]
  });

  const result = await context.run();

  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).merged, true);
  assert.deepEqual(JSON.parse(result.stdout).testMove, { moved: true, columnId: 'col-testing' });
  assert.equal(writes(context.api).length, 1);
  assert.equal(context.fixture.requests.filter((request) => request.method === 'PUT').length, 1);
  assert.equal(context.state.reads, 2);
});

test('an incomplete 2xx receipt after a successful GET still performs exactly one card PATCH', async (t) => {
  const context = await setup(t, {
    mr: ({ fixture, merges }) => (merges === 0 ? openMr(fixture) : mergedMr(fixture)),
    merge: () => [200, { iid: 5, state: 'merged' }]
  });

  const result = await context.run();

  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).merged, true);
  assert.deepEqual(JSON.parse(result.stdout).testMove, { moved: true, columnId: 'col-testing' });
  assert.equal(context.fixture.requests.filter((request) => request.method === 'PUT').length, 1);
  assert.equal(context.state.reads, 2);
  assert.equal(writes(context.api).length, 1);
});

test('an ambiguous merge transport stops without a second PUT or a board move', async (t) => {
  const context = await setup(t, { destroyMerge: true });

  const result = await context.run();

  assert.equal(result.status, 1);
  assert.match(result.stderr, /не подтверждён|повтор/);
  assert.equal(context.fixture.requests.filter((request) => request.method === 'PUT').length, 1);
  assert.deepEqual(writes(context.api), []);
});

test('a rejected merge writes nothing and is not followed by another request', async (t) => {
  const context = await setup(t, {
    merge: () => [409, { message: 'SHA does not match HEAD of source branch' }]
  });

  const result = await context.run();

  assert.equal(result.status, 1);
  assert.match(result.stderr, /409/);
  assert.equal(context.fixture.requests.filter((request) => request.method === 'PUT').length, 1);
  assert.equal(context.state.reads, 1);
  assert.deepEqual(writes(context.api), []);
});

test('no linked card means no merge request is sent', async (t) => {
  const context = await setup(t, {
    tasks: [task(99, { kanbanColumnId: 'col-review' })]
  });

  const result = await context.run();

  assert.equal(result.status, 1);
  assert.deepEqual(context.fixture.requests, []);
  assert.deepEqual(writes(context.api), []);
});

test('a resolved project must equal the pinned project id, not just its own fields', async (t) => {
  const context = await setup(t, {
    mr: (args) => openMr(args.fixture, {
      project_id: 41, source_project_id: 41, target_project_id: 41
    })
  });

  const result = await context.run();

  assert.equal(result.status, 1);
  assert.match(result.stderr, /другой проект/);
  assert.deepEqual(writes(context.api), []);
  assert.ok(!context.fixture.requests.some((request) => request.method === 'PUT'));
});

test('one stale or mismatched source-head field blocks even when the other matches', async (t) => {
  const variants = [
    { sha: 'e'.repeat(40) },
    { diff_refs: { base_sha: baseSha, start_sha: startSha, head_sha: 'e'.repeat(40) } }
  ];
  for (const override of variants) {
    const context = await setup(t, {
      mr: ({ fixture, reads }) => (reads === 1 ? openMr(fixture) : mergedMr(fixture, override)),
      merge: ({ fixture }) => [200, mergedMr(fixture, override)]
    });

    const result = await context.run();

    assert.equal(result.status, 1, JSON.stringify(override));
    assert.equal(context.fixture.requests.filter((request) => request.method === 'PUT').length, 1);
    assert.equal(context.state.reads, 2);
    assert.deepEqual(writes(context.api), []);
  }
});

test('a definite 403 has one PUT, no retry and no board move', async (t) => {
  const context = await setup(t, {
    merge: () => [403, { message: 'insufficient permissions' }]
  });

  const result = await context.run();

  assert.equal(result.status, 1);
  assert.match(result.stderr, /403/);
  assert.equal(context.fixture.requests.filter((request) => request.method === 'PUT').length, 1);
  assert.equal(context.state.reads, 1);
  assert.deepEqual(writes(context.api), []);
});

test('an ambiguous 5xx is settled by one GET with merged:true and zero board writes', async (t) => {
  const context = await setup(t, {
    tasks: [task(12, { kanbanColumnId: 'col-review' }), task(123, { kanbanColumnId: 'col-testing' })],
    mr: ({ fixture, reads }) => (reads === 1 ? openMr(fixture) : mergedMr(fixture)),
    merge: () => [500, { message: 'upstream unavailable' }]
  });

  const result = await context.run();

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout).testMove, {
    moved: false, reason: 'ambiguous-merge'
  });
  assert.equal(JSON.parse(result.stdout).merged, true);
  assert.equal(context.fixture.requests.filter((request) => request.method === 'PUT').length, 1);
  assert.equal(context.state.reads, 2);
  assert.deepEqual(writes(context.api), []);
});

test('an ambiguous 5xx without a merged GET reports unconfirmed and writes nothing', async (t) => {
  const context = await setup(t, {
    tasks: [task(12, { kanbanColumnId: 'col-review' }), task(123, { kanbanColumnId: 'col-testing' })],
    merge: () => [500, { message: 'upstream unavailable' }]
  });

  const result = await context.run();

  assert.equal(result.status, 1);
  assert.match(result.stderr, /не подтверждён/);
  assert.equal(context.fixture.requests.filter((request) => request.method === 'PUT').length, 1);
  assert.deepEqual(writes(context.api), []);
});

test('a board failure or unconfirmed read-back keeps merged:true and never re-merges', async (t) => {
  const cases = [
    { write: () => [403, {}], reason: 'failed' },
    { write: () => [200, {}], autoWrite: false, reason: 'unconfirmed' }
  ];
  for (const options of cases) {
    const context = await setup(t, {
      tasks: [task(12, { kanbanColumnId: 'col-review' }), task(123, { kanbanColumnId: 'col-testing' })],
      merge: ({ fixture }) => [200, mergedMr(fixture)],
      ...options
    });

    const result = await context.run();

    assert.equal(result.status, 0, result.stderr);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.merged, true, JSON.stringify(options));
    assert.deepEqual(parsed.testMove, { moved: false, reason: options.reason });
    assert.equal(context.fixture.requests.filter((request) => request.method === 'PUT').length, 1);
    assert.equal(writes(context.api).length, 1);
  }
});

test('requirement, key or route drift after a confirmed merge blocks the PATCH', async (t) => {
  const cases = [
    {
      mutate: (tasks) => { tasks.find((entry) => entry.id === '12').desc = 'Новые требования'; },
      at: 2
    },
    {
      mutate: (tasks) => { tasks.push(task(77, { taskKey: key, kanbanColumnId: 'col-review' })); },
      at: 2
    },
    {
      mutate: (tasks, board) => { board.columns.find((column) => column.id === 'col-testing').id = 'col-other'; },
      at: 3,
      board: true
    }
  ];
  for (const drift of cases) {
    const tasks = [task(12, { kanbanColumnId: 'col-review' }), task(123, { kanbanColumnId: 'col-testing' })];
    let boardReads = 0;
    const context = await setup(t, {
      tasks,
      board: () => {
        boardReads += 1;
        const snapshot = boardFixture(tasks);
        if (boardReads === drift.at) drift.mutate(tasks, snapshot);
        return snapshot;
      },
      merge: ({ fixture }) => [200, mergedMr(fixture)]
    });

    const result = await context.run();

    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).merged, true, JSON.stringify(drift));
    assert.deepEqual(JSON.parse(result.stdout).testMove, { moved: false, reason: 'failed' });
    assert.equal(context.fixture.requests.filter((request) => request.method === 'PUT').length, 1);
    assert.deepEqual(writes(context.api), []);
  }
});

test('board drift during the discussion scan blocks before the final MR GET and PUT', async (t) => {
  const tasks = [task(12, { kanbanColumnId: 'col-review' }), task(123, { kanbanColumnId: 'col-testing' })];
  let boardReads = 0;
  const context = await setup(t, {
    tasks,
    board: () => {
      boardReads += 1;
      if (boardReads === 1) tasks.find((entry) => entry.id === '12').desc = 'Новые требования';
      return boardFixture(tasks);
    }
  });

  const result = await context.run();

  assert.equal(result.status, 1);
  assert.match(result.stderr, /изменились/);
  assert.ok(!context.fixture.requests.some((request) => request.method === 'PUT'));
  assert.deepEqual(writes(context.api), []);
});

test('a replaced card key at read-back is unconfirmed, not a success', async (t) => {
  const tasks = [task(12, { kanbanColumnId: 'col-review' }), task(123, { kanbanColumnId: 'col-testing' })];
  let boardReads = 0;
  const context = await setup(t, {
    tasks,
    board: () => {
      boardReads += 1;
      if (boardReads === 3) tasks.find((entry) => entry.id === '12').taskKey = 'STR-99';
      return boardFixture(tasks);
    },
    merge: ({ fixture }) => [200, mergedMr(fixture)]
  });

  const result = await context.run();

  assert.equal(result.status, 0, result.stderr);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.merged, true);
  assert.deepEqual(parsed.testMove, { moved: false, reason: 'unconfirmed' });
  assert.equal(writes(context.api).length, 1);
  assert.equal(context.fixture.requests.filter((request) => request.method === 'PUT').length, 1);
});
