import fs from 'node:fs';
import { GantusError } from './config.mjs';
import { request } from './http.mjs';
import {
  assertCommentAllowed,
  assertEditAllowed,
  fetchBoard,
  resolveCard,
  reviewColumn,
  taskId,
  verifyIdentity
} from './api.mjs';
import {
  assertBaseBranch,
  assertProjectRemote,
  branchExists,
  currentBranch,
  hasPublishedEvidence,
  head,
  renameCurrentBranch,
  validBranchName,
  worktreeState
} from './git.mjs';
import { isTaskKey, singleTaskKey } from './keys.mjs';

const EDITABLE = new Set(['name', 'desc', 'priority']);
const FORBIDDEN_EDIT = new Set([
  'status',
  'assignee',
  'start',
  'end',
  'category',
  'planned'
]);
const PRIORITIES = new Set(['P0', 'P1', 'P2', 'P3']);

function requiredValue(flags, name) {
  const value = flags[name];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new GantusError(`не указан --${name}`, 'usage');
  }
  return value;
}

function checkPriority(value) {
  if (value !== undefined && !PRIORITIES.has(value)) {
    throw new GantusError('--priority: допустимы P0, P1, P2, P3', 'usage');
  }
}

function checkDate(name, value) {
  if (value === undefined) return;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new GantusError(`--${name}: ожидается дата YYYY-MM-DD`, 'usage');
  }
  const date = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
    throw new GantusError(`--${name}: некорректная дата`, 'usage');
  }
}

function checkDates(flags) {
  checkDate('start', flags.start);
  checkDate('end', flags.end);
  if (flags.start !== undefined && flags.end !== undefined && flags.start > flags.end) {
    throw new GantusError('--start не может быть позже --end', 'usage');
  }
}

function cardView(board, card) {
  const column = board.columns.find((item) => item.id === card.columnId);
  return {
    taskKey: card.taskKey,
    name: card.name,
    desc: card.desc,
    status: card.status,
    priority: card.priority,
    columnId: card.columnId,
    column: column?.name ?? null
  };
}

export function getTask(config, flags) {
  const key = requiredValue(flags, 'key');
  verifyIdentity(config);
  const board = fetchBoard(config);
  return cardView(board, resolveCard(board, key));
}

export function createTask(config, flags) {
  const name = requiredValue(flags, 'name');
  const desc = requiredValue(flags, 'desc');
  const start = requiredValue(flags, 'start');
  const end = requiredValue(flags, 'end');
  const priority = requiredValue(flags, 'priority');
  for (const unsupported of ['status', 'assignee', 'category', 'planned']) {
    if (flags[unsupported] !== undefined) {
      throw new GantusError(`--${unsupported} не принимается при создании`, 'usage');
    }
  }
  checkPriority(priority);
  checkDates({ start, end });

  verifyIdentity(config);
  const board = fetchBoard(config);
  const response = request(config, {
    method: 'POST',
    path: '/api/data/tasks',
    json: {
      name,
      desc,
      dept: board.deptId,
      team: board.teamName,
      planned: true,
      status: 'todo',
      priority,
      start,
      end,
      category: 'task'
    },
    mutation: true
  });

  const data = response?.task ?? response?.data?.task ?? response?.data ?? response ?? {};
  const id = typeof data.id === 'string' ? data.id : null;
  const taskKey = typeof data.taskKey === 'string' ? data.taskKey : null;
  if (!id || !/^[A-Za-z0-9_-]{1,128}$/.test(id) || !isTaskKey(taskKey)) {
    throw new GantusError('создание выполнено, но ответ не содержит безопасные taskKey и id; проверь вручную и не повторяй POST', 'ambiguous');
  }
  return { created: true, id, taskKey };
}

export function editTask(config, flags) {
  const key = requiredValue(flags, 'key');
  for (const forbidden of FORBIDDEN_EDIT) {
    if (flags[forbidden] !== undefined) {
      throw new GantusError(`--${forbidden} нельзя менять через edit`, 'usage');
    }
  }
  const payload = {};
  for (const field of EDITABLE) {
    if (flags[field] !== undefined) payload[field] = flags[field];
  }
  if (Object.keys(payload).length === 0) {
    throw new GantusError('edit требует хотя бы одно из полей --name, --desc, --priority', 'usage');
  }
  checkPriority(flags.priority);

  const identity = verifyIdentity(config);
  const board = fetchBoard(config);
  const card = resolveCard(board, key);
  assertEditAllowed(identity, card);
  const id = taskId(card);
  request(config, {
    method: 'PATCH',
    path: `/api/data/tasks/${encodeURIComponent(id)}`,
    json: payload,
    mutation: true
  });
  return { updated: true, taskKey: key };
}

export function commentTask(config, flags) {
  const key = requiredValue(flags, 'key');
  const body = requiredValue(flags, 'body');
  const identity = verifyIdentity(config);
  const board = fetchBoard(config);
  const card = resolveCard(board, key);
  assertEditAllowed(identity, card);
  assertCommentAllowed(card);
  const id = taskId(card);
  request(config, {
    method: 'POST',
    path: `/api/data/tasks/${encodeURIComponent(id)}/comments`,
    json: { body },
    mutation: true
  });
  return { commented: true, taskKey: key };
}

function compareCards(left, right) {
  const leftOrder = left.order === null ? Number.POSITIVE_INFINITY : left.order;
  const rightOrder = right.order === null ? Number.POSITIVE_INFINITY : right.order;
  if (leftOrder !== rightOrder) return leftOrder - rightOrder;
  const leftId = Number(left.id);
  const rightId = Number(right.id);
  if (Number.isFinite(leftId) && Number.isFinite(rightId) && leftId !== rightId) {
    return leftId - rightId;
  }
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}

function targetSelector(flags) {
  if (flags.column !== undefined && flags.to !== undefined) {
    throw new GantusError('укажите либо --column, либо --to review', 'usage');
  }
  if (flags.to !== undefined) {
    if (flags.to !== 'review') {
      throw new GantusError('--to поддерживает только review', 'usage');
    }
    return { kind: 'review' };
  }
  if (flags.column !== undefined) {
    if (typeof flags.column !== 'string' || flags.column === '') {
      throw new GantusError('--column: ожидается идентификатор колонки', 'usage');
    }
    return { kind: 'column', id: flags.column };
  }
  throw new GantusError('укажите --column <id> или --to review', 'usage');
}

function resolveTarget(board, selector) {
  if (selector.kind === 'review') return reviewColumn(board);
  const column = board.columns.find((item) => item.id === selector.id);
  if (!column || column.boardId !== board.id) {
    throw new GantusError('колонка не найдена на настроенной доске', 'not-found');
  }
  return column;
}

function performMove(config, identity, key, selector) {
  const board = fetchBoard(config);
  const card = resolveCard(board, key);
  assertEditAllowed(identity, card);
  const target = resolveTarget(board, selector);
  if (card.columnId === target.id) {
    return { moved: false, taskKey: key, columnId: target.id, reason: 'already' };
  }
  const ordered = board.cards
    .filter((item) => item.columnId === target.id && item.id !== card.id)
    .sort(compareCards)
    .map((item) => item.id);
  ordered.push(card.id);
  request(config, {
    method: 'PATCH',
    path: `/api/kanban/cards/${encodeURIComponent(card.id)}`,
    json: { columnId: target.id, orderedIds: ordered },
    mutation: true
  });
  return { moved: true, taskKey: key, columnId: target.id };
}

export function moveTask(config, flags) {
  const key = requiredValue(flags, 'key');
  const selector = targetSelector(flags);
  const identity = verifyIdentity(config);
  return performMove(config, identity, key, selector);
}

function readMrReceipt(value) {
  let text;
  if (value.trimStart().startsWith('{')) {
    text = value;
  } else {
    try {
      const stat = fs.statSync(value);
      if (!stat.isFile() || stat.size > 65536) throw new Error('size');
      text = fs.readFileSync(value, 'utf8');
    } catch {
      throw new GantusError('--mr: не удалось прочитать JSON-квитанцию MR', 'usage');
    }
  }
  if (text.length > 65536) {
    throw new GantusError('--mr: квитанция MR слишком велика', 'usage');
  }
  let receipt;
  try {
    receipt = JSON.parse(text);
  } catch {
    throw new GantusError('--mr: квитанция MR не является JSON', 'usage');
  }
  if (!receipt || typeof receipt !== 'object') {
    throw new GantusError('--mr: квитанция MR пуста', 'usage');
  }
  const iidOk = (typeof receipt.iid === 'number' && Number.isSafeInteger(receipt.iid))
    || (typeof receipt.iid === 'string' && /^\d+$/.test(receipt.iid));
  let webUrl = null;
  try {
    webUrl = new URL(receipt.web_url);
  } catch {
    webUrl = null;
  }
  if (!iidOk || !webUrl || typeof receipt.source_branch !== 'string'
      || receipt.source_branch === '') {
    throw new GantusError('--mr: квитанция не содержит iid, web_url или source_branch', 'usage');
  }
  if (receipt.state !== 'opened') {
    throw new GantusError('--mr: MR не открыт; перенос отменён', 'ambiguous');
  }
  if (receipt.draft !== false) {
    throw new GantusError('--mr: MR Draft или draft не подтверждён; перенос отменён', 'ambiguous');
  }
  return receipt;
}

function expectedMrUrl(remote, iid) {
  let host;
  let projectPath;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(remote)) {
    let url;
    try {
      url = new URL(remote);
    } catch {
      return null;
    }
    host = url.host;
    projectPath = url.pathname;
  } else {
    const match = /^[^@\s]+@([^:\s]+):(.+)$/.exec(remote);
    if (!match) return null;
    host = match[1];
    projectPath = match[2];
  }
  projectPath = projectPath.replace(/^\/+|\/+$/g, '').replace(/\.git$/, '');
  if (!host || !projectPath) return null;
  return `https://${host}/${projectPath}/-/merge_requests/${iid}`;
}

export function reviewReady(config, flags, cwd) {
  const key = requiredValue(flags, 'key');
  if (flags.branch !== undefined) {
    throw new GantusError('review-ready принимает подтверждённую квитанцию --mr, а не --branch', 'usage');
  }
  const receipt = readMrReceipt(requiredValue(flags, 'mr'));
  const current = currentBranch(cwd);
  if (!current || current !== receipt.source_branch) {
    throw new GantusError('текущая ветка не совпадает с source_branch квитанции MR', 'git');
  }
  singleTaskKey(receipt.source_branch, key);
  assertProjectRemote(config, cwd);
  const expected = expectedMrUrl(config.gitRemote, receipt.iid);
  if (!expected || receipt.web_url.replace(/\/+$/, '') !== expected) {
    throw new GantusError('--mr: web_url не совпадает с проектом из GANTUS_GIT_REMOTE', 'ambiguous');
  }
  const identity = verifyIdentity(config);
  return performMove(config, identity, key, { kind: 'review' });
}

function assertRenameStillSafe(config, cwd, current, target) {
  assertProjectRemote(config, cwd);
  if (currentBranch(cwd) !== current) {
    throw new GantusError('ветка сменилась во время проверки; переименование отменено', 'git');
  }
  assertBaseBranch(cwd, current);
  if (hasPublishedEvidence(cwd, current)) {
    throw new GantusError('текущая ветка опубликована; переименование отменено', 'git');
  }
  if (branchExists(cwd, target)) {
    throw new GantusError(`ветка ${target} уже существует; переименование отменено`, 'git');
  }
}

export function renameBranch(config, flags, cwd) {
  const key = requiredValue(flags, 'key');
  const target = requiredValue(flags, 'branch');
  assertProjectRemote(config, cwd);
  if (!validBranchName(cwd, target)) {
    throw new GantusError('--branch: некорректное имя ветки', 'git');
  }
  singleTaskKey(target, key);
  const current = currentBranch(cwd);
  if (!current) {
    throw new GantusError('HEAD отсоединён; переименование отменено', 'git');
  }
  assertBaseBranch(cwd, current);
  if (current === target) {
    return { renamed: false, branch: current, head: head(cwd) };
  }
  if (hasPublishedEvidence(cwd, current)) {
    throw new GantusError('текущая ветка опубликована; переименование отменено', 'git');
  }
  if (branchExists(cwd, target)) {
    throw new GantusError(`ветка ${target} уже существует; переименование отменено`, 'git');
  }

  verifyIdentity(config);
  const board = fetchBoard(config);
  resolveCard(board, key);

  assertRenameStillSafe(config, cwd, current, target);
  const beforeHead = head(cwd);
  const beforeState = worktreeState(cwd);
  renameCurrentBranch(cwd, current, target);
  const afterHead = head(cwd);
  const afterState = worktreeState(cwd);
  if (afterHead !== beforeHead || afterState !== beforeState) {
    throw new GantusError('ветка переименована, но состояние HEAD или рабочего дерева изменилось', 'git');
  }
  return { renamed: true, from: current, to: target, head: afterHead };
}

export function dispatch({ command, flags }, config, cwd) {
  if (command === 'get') return getTask(config, flags);
  if (command === 'create') return createTask(config, flags);
  if (command === 'edit') return editTask(config, flags);
  if (command === 'comment') return commentTask(config, flags);
  if (command === 'move') return moveTask(config, flags);
  if (command === 'review-ready') return reviewReady(config, flags, cwd);
  if (command === 'rename-branch') return renameBranch(config, flags, cwd);
  throw new GantusError('неизвестная команда', 'usage');
}
