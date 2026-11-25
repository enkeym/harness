import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

export const cli = path.resolve(import.meta.dirname, '../scripts/gantus.mjs');

export function startServer(handler) {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks).toString('utf8');
    const record = { method: req.method, url: req.url, headers: req.headers, body };
    requests.push(record);
    try {
      await handler(req, res, body, record);
    } catch {
      if (!res.headersSent) res.writeHead(500);
      res.end();
    }
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        url: `http://127.0.0.1:${port}`,
        requests,
        close: () => new Promise((done) => server.close(done))
      });
    });
  });
}

export function sendJson(res, status, body) {
  const text = body === undefined ? '' : JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(text)
  });
  res.end(text);
}

export const identity = { id: 7, employeeId: 'emp-1', role: 'user' };
export const boardPath = '/api/kanban/boards/team-1';
export const bootstrapPath = '/api/data/bootstrap';
export const taskPath = '/api/data/tasks';
export const remote = 'https://git.example.invalid/group/repo.git';
export const createArgs = [
  'create', '--name', 'Новая задача', '--desc', 'Проверить результат',
  '--start', '2026-11-25', '--end', '2026-11-27', '--priority', 'P2'
];

export function task(number, overrides = {}) {
  return {
    id: String(number),
    kanbanColumnId: 'col-todo',
    kanbanOrder: number,
    taskKey: `STR-${number}`,
    name: `Задача ${number}`,
    desc: 'Описание',
    status: 'todo',
    priority: 'P2',
    assignee: 'emp-2',
    creatorUserId: 8,
    editProtected: false,
    dept: 'dept-1',
    team: 'Команда',
    taskNumber: number,
    ...overrides
  };
}

export function boardFixture(tasks = [task(12), task(123)]) {
  return {
    board: { id: 'b1', deptId: 'dept-1', teamId: 'team-1', teamName: 'Команда' },
    columns: [
      { id: 'col-todo', boardId: 'b1', status: 'todo', name: 'В работе' },
      { id: 'col-review', boardId: 'b1', status: 'review', name: 'На ревью' },
      { id: 'col-done', boardId: 'b1', status: 'done', name: 'Готово' }
    ],
    cards: tasks.map((entry) => ({
      id: entry.id, columnId: entry.kanbanColumnId, order: entry.kanbanOrder,
      status: entry.status, name: entry.name, desc: entry.desc
    }))
  };
}

export async function apiFixture(t, options = {}) {
  const tasks = options.tasks ?? [task(12), task(123)];
  const board = options.board ?? boardFixture(tasks);
  let servedBoard = typeof board === 'function' ? null : board;
  const bootstrap = {
    departments: [{ id: 'dept-1', tag: 'STR', teamComments: { Команда: options.comments ?? true } }],
    tasks,
    ...options.bootstrap
  };
  const server = await startServer((req, res) => {
    if (req.method === 'GET') {
      if (req.url === '/api/auth/me') return sendJson(res, 200, options.identity ?? identity);
      if (req.url === boardPath) {
        if (typeof board === 'function') servedBoard = board();
        return sendJson(res, 200, servedBoard);
      }
      if (req.url === bootstrapPath) return sendJson(res, 200, bootstrap);
      return sendJson(res, 404);
    }
    const reply = options.write ? options.write(req, servedBoard) : [200, {}];
    sendJson(res, ...reply);
  });
  t.after(() => server.close());
  return {
    run: (args, { cwd, env } = {}) => runCli(args, { cwd, env: gantusEnv(server.url, env) }),
    server,
    writes: () => server.requests.filter((request) => request.method !== 'GET')
  };
}

export function gantusEnv(url, overrides = {}) {
  return {
    GANTUS_BASE_URL: url,
    GANTUS_TEAM_ID: 'team-1',
    GANTUS_SESSION_COOKIE: 'session=test-cookie',
    GANTUS_USER_ID: '7',
    ...overrides
  };
}

export function runCli(args, { env = {}, cwd = process.cwd() } = {}) {
  return new Promise((resolve) => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gantus-home-'));
    const child = spawn(process.execPath, [cli, ...args], {
      cwd,
      env: {
        PATH: process.env.PATH,
        HOME: home,
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_AUTHOR_NAME: 'Test',
        GIT_AUTHOR_EMAIL: 'test@example.invalid',
        GIT_COMMITTER_NAME: 'Test',
        GIT_COMMITTER_EMAIL: 'test@example.invalid',
        ...env
      }
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, 20000);
    child.on('close', (status, signal) => {
      clearTimeout(timer);
      fs.rmSync(home, { recursive: true, force: true });
      resolve({ status, signal, stdout, stderr, timedOut });
    });
  });
}

export function git(cwd, args) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_AUTHOR_NAME: 'Test',
      GIT_AUTHOR_EMAIL: 'test@example.invalid',
      GIT_COMMITTER_NAME: 'Test',
      GIT_COMMITTER_EMAIL: 'test@example.invalid'
    }
  }).trim();
}

export function initRepo(t, { branch = 'wip', upstream = remote } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'gantus-git-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  git(directory, ['init', '-q', '-b', 'main']);
  git(directory, ['config', 'user.email', 'test@example.invalid']);
  git(directory, ['config', 'user.name', 'Test']);
  fs.writeFileSync(path.join(directory, 'file.txt'), 'one\n');
  git(directory, ['add', 'file.txt']);
  git(directory, ['commit', '-q', '-m', 'init']);
  git(directory, ['remote', 'add', 'origin', upstream]);
  if (branch !== 'main') git(directory, ['switch', '-q', '-c', branch]);
  return directory;
}
