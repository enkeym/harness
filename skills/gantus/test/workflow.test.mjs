import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { apiFixture, boardFixture, boardPath, createArgs, git, initRepo, remote, task, taskPath } from './helpers.mjs';

const key = ['--key', 'STR-12'];
const edit = ['edit', ...key, '--priority', 'P3'];
const comment = ['comment', ...key, '--body', 'Готово к проверке'];
const move = ['move', ...key, '--to', 'review'];
const rename = ['rename-branch', ...key, '--branch', 'feature/STR-12-from-gantus'];

function resultOf(result) {
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test('exact STR lookup joins the wire board and a realistically sized bootstrap', async (t) => {
  const tasks = [task(12, { taskKey: undefined }), task(123, { desc: 'other task' })];
  const api = await apiFixture(t, { tasks, bootstrap: { padding: 'x'.repeat(9_300_000) } });

  const result = resultOf(await api.run(['get', ...key]));

  assert.equal(result.taskKey, 'STR-12');
  assert.equal(result.name, 'Задача 12');
  assert.doesNotMatch(JSON.stringify(result), /other task|emp-|padding/);
});

test('ambiguous, out-of-scope and missing STR keys never write', async (t) => {
  for (const tasks of [
    [task(12), task(123, { taskKey: 'STR-12' })],
    [task(12, { team: 'Другая команда' }), task(123)],
    [task(12, { dept: 'other-dept' }), task(123)],
    [task(123)]
  ]) {
    const api = await apiFixture(t, { tasks });
    const result = await api.run(edit);

    assert.equal(result.status, 1);
    assert.match(result.stderr, /несколько карточек|не найдена/);
    assert.deepEqual(api.writes(), []);
  }
});

test('wrong board identity blocks create, and dates are validated before network', async (t) => {
  const board = boardFixture();
  board.board.teamId = 'other-board';
  const api = await apiFixture(t, { board });

  const invalid = createArgs.map((value) => value === '2026-11-25' ? '2026-02-31' : value);
  assert.match((await api.run(invalid)).stderr, /некорректная дата/);
  assert.equal(api.server.requests.length, 0);

  assert.match((await api.run(createArgs)).stderr, /не совпадает/);
  assert.deepEqual(api.writes(), []);
});

test('create posts the description and planned team fields once and returns the key', async (t) => {
  const api = await apiFixture(t, { write: () => [201, { id: '15', taskKey: 'STR-15' }] });

  assert.deepEqual(resultOf(await api.run(createArgs)), { created: true, id: '15', taskKey: 'STR-15' });

  const [post] = api.writes();
  assert.equal(api.writes().length, 1);
  assert.equal(post.url, taskPath);
  assert.equal(post.method, 'POST');
  assert.equal(post.headers['content-type'], 'application/json');
  assert.deepEqual(JSON.parse(post.body), {
    name: 'Новая задача', desc: 'Проверить результат', dept: 'dept-1', team: 'Команда',
    planned: true, status: 'todo', category: 'task', priority: 'P2',
    start: '2026-11-25', end: '2026-11-27', assignee: 'emp-1'
  });
});

test('create refuses an identity without employeeId and does not POST', async (t) => {
  const api = await apiFixture(t, { identity: { id: 7, employeeId: null, role: 'user' } });

  const result = await api.run(createArgs);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /employeeId/);
  assert.deepEqual(api.writes(), []);
});

test('5xx and a successful status without a task key do not cause a second POST', async (t) => {
  for (const reply of [[502, {}], [201, { id: '15' }]]) {
    const api = await apiFixture(t, { write: () => reply });

    const result = await api.run(createArgs);

    assert.equal(result.status, 1);
    assert.match(result.stderr, /не повторяй/);
    assert.equal(api.writes().length, 1);
  }
});

test('edit and comment on an open task send only requested fields and body', async (t) => {
  const api = await apiFixture(t);

  const invalid = await api.run([...edit, '--status', 'done']);
  assert.equal(invalid.status, 2);
  assert.equal(api.server.requests.length, 0);
  assert.equal(resultOf(await api.run(edit)).updated, true);
  assert.equal(resultOf(await api.run(comment)).commented, true);

  assert.deepEqual(api.writes().map(({ method, url, body }) => [method, url, JSON.parse(body)]), [
    ['PATCH', `${taskPath}/12`, { priority: 'P3' }],
    ['POST', `${taskPath}/12/comments`, { body: 'Готово к проверке' }]
  ]);
});

test('protected tasks and disabled team comments do not bypass browser access rules', async (t) => {
  const locked = await apiFixture(t, { tasks: [task(12, { editProtected: true })] });
  for (const command of [edit, comment, move]) {
    assert.match((await locked.run(command)).stderr, /недоступн|защищена/);
  }
  assert.deepEqual(locked.writes(), []);

  const disabled = await apiFixture(t, { comments: false });
  assert.match((await disabled.run(comment)).stderr, /комментарии.*отключены/i);
  assert.deepEqual(disabled.writes(), []);

  const owner = await apiFixture(t, { tasks: [task(12, { editProtected: true, assignee: 'emp-1' })] });
  assert.equal(resultOf(await owner.run(edit)).updated, true);
});

test('review move appends once and keeps the order of all target cards', async (t) => {
  const tasks = [
    task(12), task(123, { kanbanColumnId: 'col-review', kanbanOrder: 5 }),
    task(22, { kanbanColumnId: 'col-review', kanbanOrder: 1 })
  ];
  const board = boardFixture(tasks);
  board.cards.push({ id: '999', columnId: 'col-review', order: 3 });
  const api = await apiFixture(t, {
    tasks, board, write: (req) => {
      board.cards.find((entry) => entry.id === '12').columnId = 'col-review';
      return [200, {}];
    }
  });

  assert.equal(resultOf(await api.run(move)).moved, true);
  assert.equal(resultOf(await api.run(move)).reason, 'already');

  assert.deepEqual(api.writes().map(({ url, body }) => [url, JSON.parse(body)]), [
    ['/api/kanban/cards/12', { columnId: 'col-review', orderedIds: ['22', '999', '123', '12'] }]
  ]);
});

test('a move derives its guards and patch from one fresh board snapshot', async (t) => {
  const tasks = [
    task(12), task(22, { kanbanColumnId: 'col-review', kanbanOrder: 1 }),
    task(123, { kanbanColumnId: 'col-review', kanbanOrder: 5 })
  ];
  const guarded = boardFixture(tasks);
  const drifted = boardFixture(tasks);
  drifted.columns.push({ id: 'col-review-2', boardId: 'b1', status: 'review', name: 'Второе ревью' });
  drifted.cards.find((entry) => entry.id === '22').order = 9;
  drifted.cards.find((entry) => entry.id === '12').columnId = 'col-done';
  let reads = 0;
  const api = await apiFixture(t, {
    tasks,
    board: () => {
      reads += 1;
      return reads === 1 ? guarded : drifted;
    }
  });

  assert.equal(resultOf(await api.run(move)).moved, true);

  assert.equal(api.server.requests.filter((request) => request.url === boardPath).length, 1);
  assert.deepEqual(api.writes().map(({ url, body }) => [url, JSON.parse(body)]), [
    ['/api/kanban/cards/12', { columnId: 'col-review', orderedIds: ['22', '123', '12'] }]
  ]);
});

test('no review column, ambiguous review or missing card cannot reorder the board', async (t) => {
  const noReview = boardFixture();
  noReview.columns = noReview.columns.filter((column) => column.status !== 'review');
  const duplicate = boardFixture();
  duplicate.columns.push({ id: 'col-review-2', boardId: 'b1', status: 'review' });
  for (const board of [noReview, duplicate, boardFixture([task(123)])]) {
    const api = await apiFixture(t, { board });

    assert.match((await api.run(move)).stderr, /колонки|колонок|не найдена/);
    assert.deepEqual(api.writes(), []);
  }
});

test('rename uses the authoritative name and preserves HEAD, staged and unstaged changes', async (t) => {
  const cwd = initRepo(t);
  const api = await apiFixture(t);
  const file = path.join(cwd, 'file.txt');
  fs.writeFileSync(file, 'staged\n');
  git(cwd, ['add', 'file.txt']);
  fs.appendFileSync(file, 'unstaged\n');
  fs.writeFileSync(path.join(cwd, 'untracked.txt'), 'untracked\n');
  const before = [
    git(cwd, ['rev-parse', 'HEAD']), git(cwd, ['diff', 'HEAD']),
    git(cwd, ['diff', '--cached']), git(cwd, ['status', '--porcelain'])
  ];

  const result = resultOf(await api.run(rename, { cwd, env: { GANTUS_GIT_REMOTE: remote } }));

  assert.equal(result.to, 'feature/STR-12-from-gantus');
  assert.equal(git(cwd, ['branch', '--show-current']), result.to);
  assert.deepEqual([
    git(cwd, ['rev-parse', 'HEAD']), git(cwd, ['diff', 'HEAD']),
    git(cwd, ['diff', '--cached']), git(cwd, ['status', '--porcelain'])
  ], before);
});

test('rename refuses base, detached, existing target, upstream and other STR', async (t) => {
  const api = await apiFixture(t);
  const cases = [
    ['main', [], rename, /базовой/],
    ['wip', [['switch', '-q', '--detach']], rename, /отсоединён/],
    ['wip', [['branch', rename.at(-1)]], rename, /уже существует/],
    ['wip', [
      ['config', 'branch.wip.remote', 'origin'], ['config', 'branch.wip.merge', 'refs/heads/wip']
    ], rename, /опубликована/],
    ['wip', [['update-ref', 'refs/remotes/origin/wip', 'HEAD']], rename, /опубликована/],
    ['wip', [['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/wip']], rename, /базовой/],
    ['wip', [], [...rename.slice(0, -1), 'feature/STR-123'], /не совпадает/]
  ];
  for (const [branch, setup, args, error] of cases) {
    const cwd = initRepo(t, { branch });
    for (const command of setup) git(cwd, command);
    const before = git(cwd, ['branch', '--list']);

    assert.match((await api.run(args, { cwd, env: { GANTUS_GIT_REMOTE: remote } })).stderr, error);
    assert.equal(git(cwd, ['branch', '--list']), before);
  }
  assert.equal(api.server.requests.length, 0);
});

test('rename rechecks the branch guards after the network checks', async (t) => {
  const cases = [
    [(cwd) => {
      git(cwd, ['config', 'branch.wip.remote', 'origin']);
      git(cwd, ['config', 'branch.wip.merge', 'refs/heads/wip']);
    }, /опубликована/, ''],
    [(cwd) => git(cwd, ['branch', rename.at(-1)]), /уже существует/, rename.at(-1)]
  ];
  for (const [mutate, expected, targetAfter] of cases) {
    const cwd = initRepo(t);
    let applied = false;
    const api = await apiFixture(t, {
      board: () => {
        if (!applied) {
          applied = true;
          mutate(cwd);
        }
        return boardFixture();
      }
    });

    const result = await api.run(rename, { cwd, env: { GANTUS_GIT_REMOTE: remote } });

    assert.equal(result.status, 1);
    assert.match(result.stderr, expected);
    assert.equal(git(cwd, ['branch', '--show-current']), 'wip');
    assert.equal(git(cwd, ['branch', '--list', rename.at(-1)]), targetAfter);
  }
});

test('automatic review requires a receipt for a new open, non-draft MR on this branch and project', async (t) => {
  const cwd = initRepo(t, { branch: 'feature/STR-12' });
  const api = await apiFixture(t);
  const receipt = {
    iid: 26, web_url: 'https://git.example.invalid/group/repo/-/merge_requests/26',
    source_branch: 'feature/STR-12', state: 'opened', draft: false
  };
  const ready = ['review-ready', ...key];
  const opts = { cwd, env: { GANTUS_GIT_REMOTE: remote } };
  assert.equal((await api.run(ready, opts)).status, 2);
  for (const invalid of [
    { ...receipt, draft: true }, { ...receipt, state: 'closed' },
    { ...receipt, source_branch: 'feature/STR-12-STR-123' },
    { ...receipt, source_branch: 'feature/STR-12-other' },
    { ...receipt, web_url: receipt.web_url.replace('/repo/', '/other/') }
  ]) {
    assert.notEqual((await api.run([...ready, '--mr', JSON.stringify(invalid)], opts)).status, 0);
  }
  assert.notEqual((await api.run([...ready, '--mr', JSON.stringify(receipt)], { cwd })).status, 0);
  assert.equal(api.server.requests.length, 0);

  assert.equal(resultOf(await api.run([...ready, '--mr', JSON.stringify(receipt)], opts)).moved, true);
  assert.equal(api.writes().length, 1);
  assert.equal(api.server.requests.filter((request) => request.url === boardPath).length, 1);
});
