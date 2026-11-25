import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { apiFixture, boardFixture, initRepo, remote, task, taskPath } from './helpers.mjs';

const source = 'feature/STR-12';
const finalDesc = 'Итоговое описание\n\nРучной контекст: проверено на стенде';
const qa = 'Изменено поведение.\n\n1. Открыть раздел.\n2. Увидеть результат.';
const qaBody = `Проверка MR !26 (${source})\n\n${qa}`;

function receipt(overrides = {}) {
  return {
    iid: 26,
    web_url: 'https://git.example.invalid/group/repo/-/merge_requests/26',
    source_branch: source,
    state: 'opened',
    draft: false,
    operation: 'create',
    author: { id: 7 },
    description: finalDesc,
    ...overrides
  };
}

function syncArgs({
  mr = receipt(), desc = finalDesc, expected = '', body = qa, userId = '7',
  expectedMrDesc, expectedCardId = '12'
} = {}) {
  const args = [
    'sync', '--key', 'STR-12', '--mr', JSON.stringify(mr), '--desc', desc,
    '--qa', body, '--gitlab-user-id', userId, '--expected-desc', expected,
    '--expected-card-id', expectedCardId
  ];
  if (expectedMrDesc !== undefined) args.push('--expected-mr-desc', expectedMrDesc);
  return args;
}

function testingEnv(overrides = {}) {
  return {
    GANTUS_GIT_REMOTE: remote,
    GANTUS_TESTING_COLUMN_ID: 'col-testing',
    GANTUS_TESTING_FROM_COLUMN_IDS: 'col-todo,col-review',
    ...overrides
  };
}

function resultOf(result) {
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test('sync writes one shared description and QA, then moves the owned card to testing', async (t) => {
  const cwd = initRepo(t, { branch: source });
  const tasks = [task(12, { assignee: 'emp-1' })];
  const board = boardFixture(tasks);
  const api = await apiFixture(t, {
    tasks,
    board,
    taskComments: [],
    write: (req) => {
      if (req.method === 'PATCH' && req.url === `${taskPath}/12`) {
        tasks[0].desc = finalDesc;
        return [200, {}];
      }
      if (req.method === 'POST' && req.url === `${taskPath}/12/comments`) return [201, { id: 'c1' }];
      if (req.method === 'PATCH' && req.url === '/api/kanban/cards/12') {
        board.cards.find((card) => card.id === '12').columnId = 'col-testing';
        return [200, {}];
      }
      return [200, {}];
    }
  });

  const result = resultOf(await api.run(syncArgs(), { cwd, env: testingEnv() }));

  assert.equal(result.description.updated, true);
  assert.equal(result.qa.commented, true);
  assert.equal(result.testingMove.moved, true);
  assert.deepEqual(api.writes().map(({ method, url, body }) => [method, url, JSON.parse(body)]), [
    ['PATCH', `${taskPath}/12`, { desc: finalDesc }],
    ['POST', `${taskPath}/12/comments`, { body: qaBody }],
    ['PATCH', '/api/kanban/cards/12', { columnId: 'col-testing', orderedIds: ['12'] }]
  ]);
});

test('sync accepts a confirmed update receipt for the current branch and project', async (t) => {
  const cwd = initRepo(t, { branch: source });
  const manual = 'Ручной контекст карточки';
  const updated = `${finalDesc}\n\n${manual}`;
  const tasks = [task(12, { assignee: 'emp-1', desc: manual })];
  const board = boardFixture(tasks);
  const api = await apiFixture(t, {
    tasks,
    board,
    taskComments: [],
    write: (req) => {
      if (req.method === 'PATCH' && req.url === `${taskPath}/12`) {
        tasks[0].desc = updated;
        return [200, {}];
      }
      if (req.method === 'POST' && req.url === `${taskPath}/12/comments`) return [201, { id: 'c1' }];
      if (req.method === 'PATCH' && req.url === '/api/kanban/cards/12') {
        board.cards.find((card) => card.id === '12').columnId = 'col-testing';
        return [200, {}];
      }
      return [200, {}];
    }
  });

  const result = resultOf(await api.run(
    syncArgs({
      mr: receipt({ operation: 'update', description: updated }),
      desc: updated,
      expected: manual,
      expectedMrDesc: manual
    }),
    { cwd, env: testingEnv() }
  ));

  assert.equal(result.mr.operation, 'update');
  assert.equal(result.description.updated, true);
  assert.equal(result.qa.commented, true);
  assert.equal(result.testingMove.moved, true);
  assert.deepEqual(JSON.parse(api.writes()[0].body), { desc: updated });
});

test('sync treats an absent card description as empty for the read comparison', async (t) => {
  const cwd = initRepo(t, { branch: source });
  const tasks = [task(12, {
    assignee: 'emp-1', kanbanColumnId: 'col-testing', desc: null
  })];
  const board = boardFixture(tasks);
  const api = await apiFixture(t, {
    tasks,
    board,
    taskComments: [{ id: 'c1', body: qaBody, authorId: 7 }],
    write: (req) => {
      if (req.method === 'PATCH' && req.url === `${taskPath}/12`) return [200, {}];
      return [200, {}];
    }
  });

  const result = resultOf(await api.run(syncArgs({ expected: '' }), { cwd, env: testingEnv() }));

  assert.equal(result.description.updated, true);
  assert.deepEqual(api.writes().map(({ method, url }) => [method, url]), [
    ['PATCH', `${taskPath}/12`]
  ]);
});

test('sync is a no-op for the same description, own QA and testing column', async (t) => {
  const cwd = initRepo(t, { branch: source });
  const tasks = [
    task(12, {
      assignee: 'emp-1', kanbanColumnId: 'col-testing', desc: finalDesc
    })
  ];
  const board = boardFixture(tasks);
  const api = await apiFixture(t, {
    tasks,
    board,
    taskComments: [{ id: 'c1', body: qaBody, authorId: 7 }]
  });

  const result = resultOf(await api.run(syncArgs({ expected: finalDesc }), { cwd, env: testingEnv() }));

  assert.equal(result.description.updated, false);
  assert.equal(result.qa.commented, false);
  assert.equal(result.qa.deduplicated, true);
  assert.equal(result.testingMove.moved, false);
  assert.equal(result.testingMove.reason, 'already');
  assert.deepEqual(api.writes(), []);
});

test('sync writes once and deduplicates on an exact GitLab origin without a testing target', async (t) => {
  const gitlabRemote = 'https://gitlab.example.invalid/team/repo.git';
  const gitlabMr = 'https://gitlab.example.invalid/team/repo/-/merge_requests/26';
  const cwd = initRepo(t, { branch: source, upstream: gitlabRemote });
  const tasks = [
    task(12, { assignee: 'emp-1', kanbanColumnId: 'col-testing', desc: '' })
  ];
  const board = boardFixture(tasks);
  const api = await apiFixture(t, { tasks, board, taskComments: [] });
  const env = { GANTUS_GIT_REMOTE: gitlabRemote };

  const first = resultOf(await api.run(
    syncArgs({ mr: receipt({ web_url: gitlabMr }), expected: '' }),
    { cwd, env }
  ));

  assert.equal(first.description.updated, true);
  assert.equal(first.qa.commented, true);
  assert.equal(first.testingMove.moved, false);
  assert.equal(first.testingMove.reason, 'not-configured');
  assert.deepEqual(api.writes().map(({ method, url, body }) => [method, url, JSON.parse(body)]), [
    ['PATCH', `${taskPath}/12`, { desc: finalDesc }],
    ['POST', `${taskPath}/12/comments`, { body: qaBody }]
  ]);

  const writesAfterFirst = api.writes().length;
  const second = resultOf(await api.run(
    syncArgs({ mr: receipt({ web_url: gitlabMr }), expected: finalDesc }),
    { cwd, env }
  ));

  assert.equal(second.description.updated, false);
  assert.equal(second.qa.commented, false);
  assert.equal(second.qa.deduplicated, true);
  assert.equal(second.testingMove.moved, false);
  assert.equal(second.testingMove.reason, 'not-configured');
  assert.equal(api.writes().length, writesAfterFirst);
});

test('sync refuses a stale description instead of replacing the latest manual edit', async (t) => {
  const cwd = initRepo(t, { branch: source });
  const tasks = [task(12, { assignee: 'emp-1', desc: 'Ручная правка' })];
  const board = boardFixture(tasks);
  const api = await apiFixture(t, { tasks, board, taskComments: [] });

  const result = await api.run(syncArgs({ expected: 'Старое описание' }), { cwd, env: testingEnv() });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /изменилось|устарел/);
  assert.deepEqual(api.writes(), []);
});

test('sync refuses a foreign card, foreign MR, draft, or a different MR body', async (t) => {
  const cases = [
    [{ tasks: [task(12, { assignee: 'emp-2', creatorUserId: 8, editProtected: false })] }, syncArgs(), /не принадлежит/],
    [{}, syncArgs({ mr: receipt({ author: { id: 8 } }) }), /автор/],
    [{}, syncArgs({ mr: receipt({ draft: true }) }), /Draft/],
    [{}, syncArgs({ mr: receipt({ description: 'Другое тело' }) }), /описание/],
    [{}, syncArgs({ mr: receipt({
      web_url: 'https://git.example.invalid/other/repo/-/merge_requests/26'
    }) }), /проект/],
    [{}, syncArgs({ mr: receipt({
      web_url: 'https://github.example.invalid/group/repo/-/merge_requests/26'
    }) }), /проект/, true],
    [{}, syncArgs({ mr: receipt({ source_branch: 'feature/STR-99' }) }), /ветка/]
  ];
  for (const [options, args, error, beforeAnyRequest = false] of cases) {
    const cwd = initRepo(t, { branch: source });
    const tasks = options.tasks ?? [task(12)];
    const board = boardFixture(tasks);
    const api = await apiFixture(t, { tasks, board, taskComments: [], ...options });

    const result = await api.run(args, { cwd, env: testingEnv() });

    assert.equal(result.status, 1);
    assert.match(result.stderr, error);
    if (beforeAnyRequest) assert.deepEqual(api.server.requests, []);
    assert.deepEqual(api.writes(), []);
  }
});

test('sync refuses a substituted card whose id differs from preflight', async (t) => {
  const cwd = initRepo(t, { branch: source });
  const tasks = [task(99, { taskKey: 'STR-12', assignee: 'emp-1', desc: finalDesc })];
  const board = boardFixture(tasks);
  const api = await apiFixture(t, { tasks, board, taskComments: [] });

  const result = await api.run(
    syncArgs({ expected: finalDesc, expectedCardId: '12' }),
    { cwd, env: testingEnv() }
  );

  assert.equal(result.status, 1);
  assert.match(result.stderr, /id из preflight/);
  assert.deepEqual(api.writes(), []);
});

test('sync requires exactly one STR key in the branch and on the board', async (t) => {
  const branches = ['feature/no-key', 'feature/STR-12-STR-13'];
  for (const branch of branches) {
    const cwd = initRepo(t, { branch });
    const tasks = [task(12, { assignee: 'emp-1' })];
    const board = boardFixture(tasks);
    const api = await apiFixture(t, { tasks, board, taskComments: [] });

    const result = await api.run(
      syncArgs({ mr: receipt({ source_branch: branch }) }),
      { cwd, env: testingEnv() }
    );

    assert.equal(result.status, 1);
    assert.match(result.stderr, /ключ/);
    assert.deepEqual(api.writes(), []);
  }
});

test('sync deduplicates only its own identical QA comment and adds a changed one', async (t) => {
  const cwd = initRepo(t, { branch: source });
  const tasks = [
    task(12, { assignee: 'emp-1', kanbanColumnId: 'col-testing', desc: finalDesc })
  ];
  const board = boardFixture(tasks);
  const foreign = await apiFixture(t, {
    tasks,
    board,
    taskComments: [{ id: 'c1', body: qaBody, authorId: 8, empId: 'emp-1' }]
  });
  const refused = await foreign.run(syncArgs({ expected: finalDesc }), { cwd, env: testingEnv() });
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /другим автором/);
  assert.deepEqual(foreign.writes(), []);

  const changed = await apiFixture(t, {
    tasks,
    board,
    taskComments: [{ id: 'c1', body: 'Старый QA', authorId: 7 }],
    write: () => [201, { id: 'c2' }]
  });
  assert.equal(resultOf(await changed.run(syncArgs({ expected: finalDesc }), { cwd, env: testingEnv() })).qa.commented, true);
  assert.deepEqual(changed.writes().map(({ url, body }) => [url, JSON.parse(body)]), [
    [`${taskPath}/12/comments`, { body: qaBody }]
  ]);
});

test('sync keeps the card in a later column and reports a missing or invalid testing target', async (t) => {
  const cwd = initRepo(t, { branch: source });
  const tasks = [
    task(12, {
      assignee: 'emp-1', kanbanColumnId: 'col-done', desc: finalDesc
    })
  ];
  const done = boardFixture(tasks);
  const later = await apiFixture(t, {
    tasks,
    board: done,
    taskComments: [{ id: 'c1', body: qaBody, authorId: 7 }]
  });
  const blocked = resultOf(await later.run(syncArgs({ expected: finalDesc }), { cwd, env: testingEnv() }));
  assert.equal(blocked.testingMove.moved, false);
  assert.equal(blocked.testingMove.reason, 'source-not-allowed');
  assert.deepEqual(later.writes(), []);

  const unconfigured = await apiFixture(t, {
    tasks,
    board: done,
    taskComments: [{ id: 'c1', body: qaBody, authorId: 7 }]
  });
  const skipped = resultOf(await unconfigured.run(syncArgs({ expected: finalDesc }), {
    cwd, env: { GANTUS_GIT_REMOTE: remote }
  }));
  assert.equal(skipped.testingMove.reason, 'not-configured');
  assert.deepEqual(unconfigured.writes(), []);

  const invalid = await apiFixture(t, { tasks, board: done, taskComments: [] });
  const missing = await invalid.run(syncArgs({ expected: finalDesc }), {
    cwd, env: testingEnv({ GANTUS_TESTING_COLUMN_ID: 'col-missing' })
  });
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /колонка/);
  assert.deepEqual(invalid.writes(), []);
});

test('sync reports completed steps and never retries after a partial write failure', async (t) => {
  const cwd = initRepo(t, { branch: source });
  const tasks = [task(12, { assignee: 'emp-1' })];
  const board = boardFixture(tasks);
  const api = await apiFixture(t, {
    tasks,
    board,
    taskComments: [],
    write: (req) => {
      if (req.method === 'PATCH' && req.url === `${taskPath}/12`) return [200, {}];
      if (req.method === 'POST' && req.url === `${taskPath}/12/comments`) return [502, {}];
      return [200, {}];
    }
  });

  const result = await api.run(syncArgs(), { cwd, env: testingEnv() });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /описание обновлено/);
  assert.match(result.stderr, /результат добавления QA не подтверждён/);
  assert.match(result.stderr, /не повторяй/);
  assert.equal(api.writes().filter((request) => request.method === 'PATCH').length, 1);
  assert.equal(api.writes().some((request) => request.url.startsWith('/api/kanban/cards/')), false);
});

test('sync reports a failed move without retrying or hiding completed text work', async (t) => {
  const cwd = initRepo(t, { branch: source });
  const tasks = [task(12, { assignee: 'emp-1', desc: finalDesc })];
  const board = boardFixture(tasks);
  const api = await apiFixture(t, {
    tasks,
    board,
    taskComments: [{ id: 'c1', body: qaBody, authorId: 7 }],
    write: (req) => {
      if (req.method === 'PATCH' && req.url === '/api/kanban/cards/12') return [502, {}];
      return [200, {}];
    }
  });

  const result = await api.run(syncArgs({ expected: finalDesc }), { cwd, env: testingEnv() });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /результат перемещения не подтверждён/);
  assert.match(result.stderr, /не повторяй/);
  assert.equal(api.writes().length, 1);
  assert.equal(api.writes()[0].url, '/api/kanban/cards/12');
});

test('sync separates a definite 403 from an ambiguous write result', async (t) => {
  const cwd = initRepo(t, { branch: source });
  const tasks = [task(12, { assignee: 'emp-1' })];
  const board = boardFixture(tasks);
  const denied = await apiFixture(t, {
    tasks,
    board,
    taskComments: [],
    write: (req) => req.method === 'PATCH' && req.url === `${taskPath}/12`
      ? [403, {}]
      : [200, {}]
  });
  const description = await denied.run(syncArgs(), { cwd, env: testingEnv() });
  assert.equal(description.status, 1);
  assert.match(description.stderr, /описание не обновлено/);
  assert.doesNotMatch(description.stderr, /не подтверждён/);

  const moveTasks = [task(12, { assignee: 'emp-1', desc: finalDesc })];
  const moveBoard = boardFixture(moveTasks);
  const moveDenied = await apiFixture(t, {
    tasks: moveTasks,
    board: moveBoard,
    taskComments: [{ id: 'c1', body: qaBody, authorId: 7 }],
    write: (req) => req.url === '/api/kanban/cards/12' ? [403, {}] : [200, {}]
  });
  const move = await moveDenied.run(syncArgs({ expected: finalDesc }), { cwd, env: testingEnv() });
  assert.equal(move.status, 1);
  assert.match(move.stderr, /карточка не перемещена/);
  assert.doesNotMatch(move.stderr, /не подтверждён/);
});

test('sync reports a failed description write without claiming a QA attempt', async (t) => {
  const cwd = initRepo(t, { branch: source });
  const tasks = [task(12, { assignee: 'emp-1' })];
  const board = boardFixture(tasks);
  const api = await apiFixture(t, {
    tasks,
    board,
    taskComments: [],
    write: (req) => {
      if (req.method === 'PATCH' && req.url === `${taskPath}/12`) return [502, {}];
      return [200, {}];
    }
  });

  const result = await api.run(syncArgs(), { cwd, env: testingEnv() });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /результат обновления описания не подтверждён/);
  assert.match(result.stderr, /QA не добавлен/);
  assert.match(result.stderr, /карточка не перемещена/);
  assert.match(result.stderr, /не повторяй/);
  assert.equal(api.writes().length, 1);
  assert.equal(api.writes()[0].url, `${taskPath}/12`);
});

test('sync accepts equals syntax and a payload file for exact option-like text', async (t) => {
  const cardDesc = '---\n\nРучной контекст  \n';
  const exact = `${cardDesc}\nИтоговый текст\n`;
  for (const mode of ['equals', 'file']) {
    const cwd = initRepo(t, { branch: source });
    const tasks = [task(12, {
      assignee: 'emp-1', kanbanColumnId: 'col-testing', desc: cardDesc
    })];
    const board = boardFixture(tasks);
    const api = await apiFixture(t, {
      tasks,
      board,
      taskComments: [{ id: 'c1', body: qaBody, authorId: 7 }],
      write: (req) => {
        if (req.method === 'PATCH' && req.url === `${taskPath}/12`) return [200, {}];
        return [200, {}];
      }
    });
    const file = path.join(cwd, 'description.txt');
    const expectedFile = path.join(cwd, 'expected.txt');
    fs.writeFileSync(file, exact, 'utf8');
    fs.writeFileSync(expectedFile, cardDesc, 'utf8');
    const textArgs = mode === 'equals'
      ? [`--desc=${exact}`, `--expected-desc=${cardDesc}`]
      : ['--desc-file', file, '--expected-desc-file', expectedFile];
    const args = [
      'sync', '--key', 'STR-12',
      '--mr', JSON.stringify(receipt({ description: exact })),
      ...textArgs,
      '--qa', qa, '--gitlab-user-id', '7',
      '--expected-card-id', '12',
      '--expected-mr-desc='
    ];

    const result = resultOf(await api.run(args, { cwd, env: testingEnv() }));

    assert.equal(result.description.updated, true);
    assert.deepEqual(JSON.parse(api.writes()[0].body), { desc: exact });
  }
});

test('sync preserves manual context from the card and an existing MR once', async (t) => {
  const generated = 'Сгенерированный раздел';
  const cardManual = 'Контекст карточки';
  const mrManual = 'Контекст MR';
  const cardDesc = `${generated}\n\n${cardManual}`;
  const mrDesc = `${generated}\n\n${mrManual}`;
  const final = `${generated}\n\n${cardManual}\n\n${mrManual}`;
  const cwd = initRepo(t, { branch: source });
  const tasks = [task(12, {
    assignee: 'emp-1', kanbanColumnId: 'col-testing', desc: cardDesc
  })];
  const board = boardFixture(tasks);
  const api = await apiFixture(t, {
    tasks,
    board,
    taskComments: [{ id: 'c1', body: qaBody, authorId: 7 }],
    write: (req) => {
      if (req.method === 'PATCH' && req.url === `${taskPath}/12`) return [200, {}];
      return [200, {}];
    }
  });
  const args = [
    'sync', '--key', 'STR-12',
    '--mr', JSON.stringify(receipt({ description: final })),
    '--desc', final, '--qa', qa, '--gitlab-user-id', '7',
    '--expected-desc', cardDesc, '--expected-mr-desc', mrDesc,
    '--expected-card-id', '12'
  ];

  const result = resultOf(await api.run(args, { cwd, env: testingEnv() }));

  assert.equal(result.description.updated, true);
  assert.deepEqual(JSON.parse(api.writes()[0].body), { desc: final });
});

test('sync blocks a merge that loses manual context or repeats a block', async (t) => {
  const cardDesc = 'Сгенерированный раздел\n\nКонтекст карточки';
  const mrDesc = 'Сгенерированный раздел\n\nКонтекст MR';
  const cases = [
    ['Сгенерированный раздел\n\nКонтекст MR', /ручной контекст/],
    ['Сгенерированный раздел\n\nСгенерированный раздел\n\nКонтекст карточки\n\nКонтекст MR', /повтор/]
  ];
  for (const [final, error] of cases) {
    const cwd = initRepo(t, { branch: source });
    const tasks = [task(12, {
      assignee: 'emp-1', kanbanColumnId: 'col-testing', desc: cardDesc
    })];
    const board = boardFixture(tasks);
    const api = await apiFixture(t, {
      tasks,
      board,
      taskComments: [{ id: 'c1', body: qaBody, authorId: 7 }]
    });
    const result = await api.run([
      'sync', '--key', 'STR-12',
      '--mr', JSON.stringify(receipt({ description: final })),
      '--desc', final, '--qa', qa, '--gitlab-user-id', '7',
      '--expected-desc', cardDesc, '--expected-mr-desc', mrDesc,
      '--expected-card-id', '12'
    ], { cwd, env: testingEnv() });

    assert.equal(result.status, 1);
    assert.match(result.stderr, error);
    assert.deepEqual(api.writes(), []);
  }
});

test('sync blocks a create that drops manual card context', async (t) => {
  const cwd = initRepo(t, { branch: source });
  const cardDesc = 'Сгенерированный раздел\n\nРучной контекст карточки';
  const final = 'Сгенерированный раздел';
  const tasks = [task(12, {
    assignee: 'emp-1', kanbanColumnId: 'col-testing', desc: cardDesc
  })];
  const board = boardFixture(tasks);
  const api = await apiFixture(t, {
    tasks,
    board,
    taskComments: [{ id: 'c1', body: qaBody, authorId: 7 }]
  });

  const result = await api.run(
    syncArgs({
      mr: receipt({ description: final }),
      desc: final,
      expected: cardDesc
    }),
    { cwd, env: testingEnv() }
  );

  assert.equal(result.status, 1);
  assert.match(result.stderr, /ручной контекст/);
  assert.deepEqual(api.writes(), []);
});

test('sync replaces declared obsolete generated blocks and keeps manual context', async (t) => {
  const cwd = initRepo(t, { branch: source });
  const cardDesc = 'Только CSV\n\nРучной контекст карточки';
  const mrDesc = 'Только CSV\n\nРучной контекст MR';
  const final = 'CSV и JSON\n\nРучной контекст карточки\n\nРучной контекст MR';
  const tasks = [task(12, {
    assignee: 'emp-1', kanbanColumnId: 'col-testing', desc: cardDesc
  })];
  const board = boardFixture(tasks);
  const api = await apiFixture(t, {
    tasks,
    board,
    taskComments: [{ id: 'c1', body: qaBody, authorId: 7 }],
    write: () => [204]
  });
  const args = syncArgs({
    mr: receipt({ operation: 'update', description: final }),
    desc: final,
    expected: cardDesc,
    expectedMrDesc: mrDesc
  });
  args.push('--replaced-desc', 'Только CSV');

  const result = resultOf(await api.run(args, { cwd, env: testingEnv() }));

  assert.equal(result.description.updated, true);
  assert.deepEqual(api.writes().map(({ method, url, body }) => [method, url, JSON.parse(body)]), [
    ['PATCH', `${taskPath}/12`, { desc: final }]
  ]);
});

test('sync blocks an obsolete generated block unless it is explicitly declared', async (t) => {
  const cwd = initRepo(t, { branch: source });
  const cardDesc = 'Только CSV\n\nРучной контекст карточки';
  const mrDesc = 'Только CSV\n\nРучной контекст MR';
  const final = 'CSV и JSON\n\nРучной контекст карточки\n\nРучной контекст MR';
  const tasks = [task(12, {
    assignee: 'emp-1', kanbanColumnId: 'col-testing', desc: cardDesc
  })];
  const board = boardFixture(tasks);
  const api = await apiFixture(t, {
    tasks,
    board,
    taskComments: [{ id: 'c1', body: qaBody, authorId: 7 }]
  });

  const result = await api.run(
    syncArgs({
      mr: receipt({ operation: 'update', description: final }),
      desc: final,
      expected: cardDesc,
      expectedMrDesc: mrDesc
    }),
    { cwd, env: testingEnv() }
  );

  assert.equal(result.status, 1);
  assert.match(result.stderr, /ручной контекст/);
  assert.deepEqual(api.writes(), []);
});

test('sync refuses to declare a block that is not present on both sides as replaced', async (t) => {
  const cwd = initRepo(t, { branch: source });
  const cardDesc = 'Только CSV\n\nРучной контекст карточки';
  const mrDesc = 'Только CSV\n\nРучной контекст MR';
  const final = 'CSV и JSON\n\nРучной контекст карточки';
  const tasks = [task(12, {
    assignee: 'emp-1', kanbanColumnId: 'col-testing', desc: cardDesc
  })];
  const board = boardFixture(tasks);
  const api = await apiFixture(t, {
    tasks,
    board,
    taskComments: [{ id: 'c1', body: qaBody, authorId: 7 }]
  });
  const args = syncArgs({
    mr: receipt({ operation: 'update', description: final }),
    desc: final,
    expected: cardDesc,
    expectedMrDesc: mrDesc
  });
  args.push('--replaced-desc', 'Ручной контекст MR');

  const result = await api.run(args, { cwd, env: testingEnv() });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /обеих|заменяемый/);
  assert.deepEqual(api.writes(), []);
});

test('sync does not advance after a 2xx payload without an observable description change', async (t) => {
  const cwd = initRepo(t, { branch: source });
  const tasks = [task(12, { assignee: 'emp-1' })];
  const board = boardFixture(tasks);
  const api = await apiFixture(t, {
    tasks,
    board,
    taskComments: [],
    autoWrite: false,
    write: (req) => req.method === 'PATCH' && req.url === `${taskPath}/12`
      ? [200, { ok: true }]
      : [200, {}]
  });

  const result = await api.run(syncArgs(), { cwd, env: testingEnv() });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /описание не подтверждено/);
  assert.match(result.stderr, /QA не добавлен/);
  assert.equal(api.writes().length, 1);
  assert.equal(api.writes()[0].url, `${taskPath}/12`);
});

test('sync does not move after a 2xx QA response without the own comment read-back', async (t) => {
  const cwd = initRepo(t, { branch: source });
  const tasks = [task(12, { assignee: 'emp-1', desc: finalDesc })];
  const board = boardFixture(tasks);
  const api = await apiFixture(t, {
    tasks,
    board,
    taskComments: [],
    autoWrite: false,
    write: (req) => req.method === 'POST' && req.url === `${taskPath}/12/comments`
      ? [201, { id: 'c1' }]
      : [200, {}]
  });

  const result = await api.run(syncArgs({ expected: finalDesc }), { cwd, env: testingEnv() });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /QA не подтверждён/);
  assert.equal(api.writes().some(({ url }) => url.startsWith('/api/kanban/cards/')), false);
});

test('sync reports an unconfirmed move when a 2xx did not change the board', async (t) => {
  const cwd = initRepo(t, { branch: source });
  const tasks = [task(12, { assignee: 'emp-1', desc: finalDesc })];
  const board = boardFixture(tasks);
  const api = await apiFixture(t, {
    tasks,
    board,
    taskComments: [{ id: 'c1', body: qaBody, authorId: 7 }],
    autoWrite: false,
    write: (req) => req.url === '/api/kanban/cards/12' ? [200, {}] : [200, {}]
  });

  const result = await api.run(syncArgs({ expected: finalDesc }), { cwd, env: testingEnv() });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /перемещение не подтверждено/);
  assert.equal(api.writes().length, 1);
  assert.equal(api.writes()[0].url, '/api/kanban/cards/12');
});

test('sync refuses to move when the same card changed after the text and QA writes', async (t) => {
  const cases = [
    [(tasks) => { tasks[0].assignee = 'emp-2'; }, /назначена/],
    [(tasks) => { tasks[0].desc = 'Ручная правка'; }, /описание.*изменилось/],
    [(tasks, board) => { board.cards[0].columnId = 'col-done'; }, /колонка/],
    [(tasks, board) => { board.cards[0].id = '99'; }, /заменена|не найдена/]
  ];
  for (const [mutate, error] of cases) {
    const cwd = initRepo(t, { branch: source });
    const tasks = [task(12, { assignee: 'emp-1', desc: finalDesc })];
    if (mutate.length > 1) {
      tasks.push(task(99, { taskKey: 'STR-12', assignee: 'emp-1', desc: finalDesc }));
    }
    const board = boardFixture([tasks[0]]);
    const api = await apiFixture(t, {
      tasks,
      board,
      taskComments: [],
      write: (req) => {
        if (req.method === 'POST' && req.url === `${taskPath}/12/comments`) {
          mutate(tasks, board);
          return [201, { id: 'c1' }];
        }
        return [200, {}];
      }
    });

    const result = await api.run(syncArgs({ expected: finalDesc }), { cwd, env: testingEnv() });

    assert.equal(result.status, 1);
    assert.match(result.stderr, error);
    assert.equal(api.writes().some(({ url }) => url.startsWith('/api/kanban/cards/')), false);
  }
});

test('sync blocks an exact QA body whose author is unknown or invalid and a foreign assignee', async (t) => {
  const cwd = initRepo(t, { branch: source });
  const tasks = [task(12, {
    assignee: 'emp-1', kanbanColumnId: 'col-testing', desc: finalDesc
  })];
  const board = boardFixture(tasks);
  for (const authorId of [null, 'invalid']) {
    const unknown = await apiFixture(t, {
      tasks,
      board,
      taskComments: [{ id: 'c1', body: qaBody, authorId }]
    });
    const result = await unknown.run(syncArgs({ expected: finalDesc }), { cwd, env: testingEnv() });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /автор/);
    assert.deepEqual(unknown.writes(), []);
  }

  const foreignTasks = [task(12, {
    assignee: 'emp-2', creatorUserId: 7, desc: finalDesc
  })];
  const foreign = await apiFixture(t, {
    tasks: foreignTasks, board: boardFixture(foreignTasks), taskComments: []
  });
  const assigned = await foreign.run(syncArgs({ expected: finalDesc }), { cwd, env: testingEnv() });
  assert.equal(assigned.status, 1);
  assert.match(assigned.stderr, /назначена/);
  assert.deepEqual(foreign.writes(), []);
});
