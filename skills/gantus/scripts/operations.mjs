import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { GantusError, isId } from './config.mjs';
import { request } from './http.mjs';
import {
  assertAssignedTo,
  assertCommentAllowed,
  assertEditAllowed,
  assertOwnedCard,
  fetchBoard,
  fetchComments,
  isOwned,
  resolveCard,
  statusColumn,
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
  originRemote,
  renameCurrentBranch,
  validBranchName,
  worktreeState
} from './git.mjs';
import { branchKeys, isTaskKey, singleTaskKey } from './keys.mjs';
import {
  assertUnresolvedDiscussions,
  fetchDiscussions,
  fetchMr,
  parseMrUrl,
  requestMerge,
  sha
} from './gitlab.mjs';

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

function textFlag(flags, name, { required = false, allowEmpty = false } = {}) {
  const direct = flags[name];
  const file = flags[`${name}-file`];
  if (direct !== undefined && file !== undefined) {
    throw new GantusError(`используйте либо --${name}, либо --${name}-file`, 'usage');
  }
  let value = direct;
  if (file !== undefined) {
    try {
      const stat = fs.statSync(file);
      if (!stat.isFile() || stat.size > 1024 * 1024) throw new Error('size');
      value = fs.readFileSync(file, 'utf8');
    } catch {
      throw new GantusError(`--${name}-file: файл недоступен или слишком большой`, 'usage');
    }
  }
  if (value === undefined) {
    if (required) throw new GantusError(`не указан --${name}`, 'usage');
    return undefined;
  }
  if (!allowEmpty && value.trim() === '') {
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

function cardView(board, card, identity) {
  const column = board.columns.find((item) => item.id === card.columnId);
  return {
    taskKey: card.taskKey,
    name: card.name,
    desc: card.desc,
    status: card.status,
    priority: card.priority,
    columnId: card.columnId,
    column: column?.name ?? null,
    own: isOwned(identity, card)
  };
}

export function getTask(config, flags) {
  const key = requiredValue(flags, 'key');
  const identity = verifyIdentity(config);
  const board = fetchBoard(config);
  return cardView(board, resolveCard(board, key), identity);
}

export function preflightTask(config, flags, cwd) {
  const explicitKey = flags.key;
  if (explicitKey !== undefined && !isTaskKey(explicitKey)) {
    throw new GantusError('--key: ожидается один строгий ключ STR-<digits>', 'usage');
  }
  if (config === null) return { configured: false };
  if (!config.gitRemote) {
    return { configured: true, applicable: false, reason: 'remote-not-configured' };
  }
  const actual = originRemote(cwd);
  if (actual === null || actual !== config.gitRemote) {
    return { configured: true, applicable: false, reason: 'remote-mismatch' };
  }
  const branch = currentBranch(cwd);
  if (!branch) throw new GantusError('preflight требует именованную текущую ветку', 'git');
  const keys = branchKeys(branch);
  if (keys.length > 1) {
    throw new GantusError(`в ветке ${branch} несколько ключей STR; действие отменено`, 'ambiguous');
  }
  if (explicitKey !== undefined) {
    if (keys.length === 0) {
      throw new GantusError(`в ветке ${branch} нет ключа STR; --key не совпадает`, 'ambiguous');
    }
    if (keys[0] !== explicitKey) {
      throw new GantusError(`ключ ветки ${keys[0]} не совпадает с задачей ${explicitKey}`, 'ambiguous');
    }
  }
  if (keys.length === 0) {
    return {
      configured: true,
      applicable: true,
      ready: false,
      reason: 'no-key',
      needsLink: true,
      branch
    };
  }
  const key = keys[0];
  const identity = verifyIdentity(config);
  const board = fetchBoard(config);
  const card = resolveCard(board, key);
  assertOwnedCard(identity, card);
  assertAssignedTo(identity, card);
  assertCommentAllowed(card);
  const plan = reviewPlan(config, board, card);
  const review = plan.kind === 'move'
    ? { planned: true, columnId: plan.target.id }
    : { planned: false, reason: plan.reason };
  if (plan.columnId !== undefined) review.columnId = plan.columnId;
  return {
    configured: true,
    applicable: true,
    ready: true,
    taskKey: key,
    card: { id: card.id, columnId: card.columnId, desc: card.desc },
    review
  };
}

export function reviewLookup(config, flags, cwd) {
  const branch = requiredValue(flags, 'branch');
  if (config === null) return { configured: false };
  if (!config.gitRemote) {
    return { configured: true, applicable: false, reason: 'remote-not-configured' };
  }
  const actual = originRemote(cwd);
  if (actual === null || actual !== config.gitRemote) {
    return { configured: true, applicable: false, reason: 'remote-mismatch' };
  }
  const keys = branchKeys(branch);
  if (keys.length === 0) {
    return { configured: true, applicable: true, found: false, reason: 'no-key', branch };
  }
  if (keys.length > 1) {
    return {
      configured: true,
      applicable: true,
      found: false,
      reason: 'several-keys',
      keys,
      branch
    };
  }
  const key = keys[0];
  verifyIdentity(config);
  const board = fetchBoard(config);
  const matches = board.cards.filter((card) => card.taskKey === key);
  if (matches.length === 0) {
    return { configured: true, applicable: true, found: false, reason: 'no-card', key };
  }
  if (matches.length > 1) {
    return { configured: true, applicable: true, found: false, reason: 'several-cards', key };
  }
  const card = matches[0];
  const column = board.columns.find((item) => item.id === card.columnId);
  return {
    configured: true,
    applicable: true,
    found: true,
    taskKey: key,
    card: {
      id: card.id,
      name: card.name,
      nameSha256: digest(card.name),
      desc: card.desc,
      descSha256: digest(card.desc),
      status: card.status,
      columnId: card.columnId,
      column: column?.name ?? null,
      assignee: card.assignee
    }
  };
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

  const identity = verifyIdentity(config);
  if (identity.employeeId === null) {
    throw new GantusError(
      'у учётной записи нет employeeId в /api/auth/me; исполнителя назначить нельзя',
      'auth'
    );
  }
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
      category: 'task',
      assignee: identity.employeeId
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
  if (selector.kind === 'review') return statusColumn(board, 'review', 'review');
  const column = board.columns.find((item) => item.id === selector.id);
  if (!column || column.boardId !== board.id) {
    throw new GantusError('колонка не найдена на настроенной доске', 'not-found');
  }
  return column;
}

function moveCardFromSnapshot(config, board, card, target) {
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
}

function performMove(config, identity, key, selector) {
  const board = fetchBoard(config);
  const card = resolveCard(board, key);
  assertEditAllowed(identity, card);
  const target = resolveTarget(board, selector);
  if (card.columnId === target.id) {
    return { moved: false, taskKey: key, columnId: target.id, reason: 'already' };
  }
  moveCardFromSnapshot(config, board, card, target);
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

function readSyncReceipt(value, desc, gitlabUserId) {
  const receipt = readMrReceipt(value);
  if (receipt.operation !== 'create' && receipt.operation !== 'update') {
    throw new GantusError('--mr: операция должна быть create или update', 'usage');
  }
  if (typeof receipt.description !== 'string' || receipt.description !== desc) {
    throw new GantusError('--mr: описание MR не совпадает с --desc', 'ambiguous');
  }
  const authorId = receipt.author?.id;
  const authorOk = (typeof authorId === 'number' && Number.isSafeInteger(authorId))
    || (typeof authorId === 'string' && /^\d+$/.test(authorId));
  if (!authorOk) {
    throw new GantusError('--mr: квитанция не содержит безопасный id автора', 'usage');
  }
  if (String(authorId) !== String(gitlabUserId)) {
    throw new GantusError('--mr: автор MR не совпадает с текущим пользователем', 'auth');
  }
  return receipt;
}

function withoutTerminalLineEndings(value) {
  let end = value.length;
  while (end > 0 && value.charCodeAt(end - 1) === 10) {
    end -= 1;
    if (end > 0 && value.charCodeAt(end - 1) === 13) end -= 1;
  }
  return value.slice(0, end);
}

function sameQaBody(left, right) {
  return withoutTerminalLineEndings(left) === withoutTerminalLineEndings(right);
}

function qaCommentBody(receipt, qa) {
  return `Проверка MR !${receipt.iid} (${receipt.source_branch})\n\n${withoutTerminalLineEndings(qa)}`;
}

function descriptionBlocks(value) {
  return value
    .split(/\n[ \t]*\n/)
    .map((block) => block.trim())
    .filter((block) => block !== '');
}

function assertManualContext(finalDesc, cardDesc, mrDesc, replacedDesc) {
  const card = descriptionBlocks(cardDesc);
  const mr = descriptionBlocks(mrDesc);
  const final = descriptionBlocks(finalDesc);
  const replaced = descriptionBlocks(replacedDesc);
  const finalSet = new Set(final);
  if (finalSet.size !== final.length) {
    throw new GantusError('итоговое описание повторяет раздел; запись отменена', 'conflict');
  }
  const cardSet = new Set(card);
  const mrSet = new Set(mr);
  const replacedSet = new Set(replaced);
  for (const block of replacedSet) {
    if (!cardSet.has(block) || !mrSet.has(block)) {
      throw new GantusError('заменяемый блок отсутствует в обеих версиях; запись отменена', 'conflict');
    }
  }
  for (const block of new Set([...card, ...mr])) {
    if (!replacedSet.has(block) && !finalSet.has(block)) {
      throw new GantusError('ручной контекст описания не сохранён; запись отменена', 'conflict');
    }
  }
}

function cardById(board, id) {
  const matches = board.cards.filter((card) => card.id === id);
  if (matches.length === 0) {
    throw new GantusError('карточка заменена или не найдена на доске; перемещение отменено', 'not-found');
  }
  if (matches.length > 1) {
    throw new GantusError('на доске несколько карточек с одним id; перемещение отменено', 'ambiguous');
  }
  return matches[0];
}

function isAmbiguousWrite(error) {
  return error instanceof GantusError && error.ambiguous === true;
}

function unconfirmedWrite(message) {
  const error = new GantusError(message, 'protocol');
  error.ambiguous = true;
  return error;
}

function reviewPlan(config, board, card) {
  if (config.reviewColumnId === null) {
    return { kind: 'skip', reason: 'not-configured' };
  }
  const target = board.columns.find((column) => column.id === config.reviewColumnId);
  if (!target) {
    throw new GantusError('колонка ревью не найдена на настроенной доске', 'not-found');
  }
  if (card.columnId === target.id) {
    return { kind: 'skip', reason: 'already', columnId: target.id };
  }
  if (!config.reviewFromColumnIds.includes(card.columnId)) {
    return { kind: 'skip', reason: 'source-not-allowed', columnId: card.columnId };
  }
  return { kind: 'move', target };
}

function moveCardToColumn(config, board, card, target) {
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
}

export function syncTask(config, flags, cwd) {
  const key = requiredValue(flags, 'key');
  const desc = textFlag(flags, 'desc', { required: true });
  const qa = textFlag(flags, 'qa', { required: true });
  const expectedDesc = textFlag(flags, 'expected-desc', { required: true, allowEmpty: true });
  const expectedMrDesc = textFlag(flags, 'expected-mr-desc', { allowEmpty: true }) ?? '';
  const replacedDesc = textFlag(flags, 'replaced-desc', { allowEmpty: true }) ?? '';
  const expectedCardId = requiredValue(flags, 'expected-card-id');
  if (!isId(expectedCardId)) {
    throw new GantusError('--expected-card-id: некорректный id карточки', 'usage');
  }
  const gitlabUserId = requiredValue(flags, 'gitlab-user-id');
  if (!/^\d+$/.test(gitlabUserId)) {
    throw new GantusError('--gitlab-user-id: ожидается числовой id пользователя', 'usage');
  }
  const receipt = readSyncReceipt(requiredValue(flags, 'mr'), desc, gitlabUserId);
  if (receipt.operation === 'update'
      && flags['expected-mr-desc'] === undefined
      && flags['expected-mr-desc-file'] === undefined) {
    throw new GantusError('sync update требует --expected-mr-desc прочитанного описания MR', 'usage');
  }
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
  const board = fetchBoard(config);
  const card = resolveCard(board, key);
  if (card.id !== expectedCardId) {
    throw new GantusError('карточка не совпадает с id из preflight; запись отменена', 'conflict');
  }
  assertOwnedCard(identity, card);
  assertAssignedTo(identity, card);
  assertCommentAllowed(card);
  const plan = reviewPlan(config, board, card);
  const currentDesc = card.desc ?? '';
  if (currentDesc !== desc && currentDesc !== expectedDesc) {
    throw new GantusError('описание карточки изменилось после сверки; запись отменена', 'conflict');
  }
  assertManualContext(desc, expectedDesc, expectedMrDesc, replacedDesc);
  const comments = fetchComments(config, card);
  const body = qaCommentBody(receipt, qa);
  const authorOf = (comment) => (
    comment.authorId === null || comment.authorId === undefined
      ? null
      : String(comment.authorId)
  );
  const matchingQa = comments.filter((comment) => sameQaBody(comment.body, body));
  if (matchingQa.some((comment) => {
    const author = authorOf(comment);
    return author === null || !/^\d+$/.test(author);
  })) {
    throw new GantusError(
      'QA-комментарий с тем же текстом имеет неизвестного автора; запись отменена',
      'ambiguous'
    );
  }
  if (matchingQa.some((comment) => authorOf(comment) !== String(identity.id))) {
    throw new GantusError(
      'QA-комментарий с тем же текстом уже добавлен другим автором; запись отменена',
      'conflict'
    );
  }
  const ownQa = matchingQa.length > 0;
  let descriptionUpdated = false;
  if (currentDesc !== desc) {
    try {
      request(config, {
        method: 'PATCH',
        path: `/api/data/tasks/${encodeURIComponent(taskId(card))}`,
        json: { desc },
        mutation: true
      });
      descriptionUpdated = true;
      try {
        const after = fetchBoard(config);
        const afterCard = cardById(after, card.id);
        if ((afterCard.desc ?? '') !== desc) {
          throw unconfirmedWrite('описание не подтверждено после записи');
        }
      } catch {
        throw unconfirmedWrite('описание не подтверждено после записи');
      }
    } catch (error) {
      if (error instanceof GantusError) {
        const ambiguous = isAmbiguousWrite(error);
        const state = ambiguous
          ? 'результат обновления описания не подтверждён'
          : 'описание не обновлено';
        const combined = new GantusError(
          `${state}; QA не добавлен; карточка не перемещена; ${error.message}`,
          error.code
        );
        combined.ambiguous = ambiguous;
        throw combined;
      }
      throw error;
    }
  }
  let commented = false;
  if (!ownQa) {
    try {
      request(config, {
        method: 'POST',
        path: `/api/data/tasks/${encodeURIComponent(taskId(card))}/comments`,
        json: { body },
        mutation: true
      });
      commented = true;
      try {
        const afterComments = fetchComments(config, card);
        const confirmed = afterComments.some((comment) => (
          sameQaBody(comment.body, body) && authorOf(comment) === String(identity.id)
        ));
        if (!confirmed) {
          throw unconfirmedWrite('QA не подтверждён после записи');
        }
      } catch {
        throw unconfirmedWrite('QA не подтверждён после записи');
      }
    } catch (error) {
      if (error instanceof GantusError) {
        const description = descriptionUpdated ? 'описание обновлено' : 'описание без изменений';
        const ambiguous = isAmbiguousWrite(error);
        const qaState = ambiguous
          ? 'результат добавления QA не подтверждён'
          : 'QA не добавлен';
        const combined = new GantusError(
          `${description}; ${qaState}; карточка не перемещена; ${error.message}`,
          error.code
        );
        combined.ambiguous = ambiguous;
        throw combined;
      }
      throw error;
    }
  }
  let reviewMove;
  if (plan.kind !== 'move') {
    reviewMove = { moved: false, reason: plan.reason };
    if (plan.columnId !== undefined) reviewMove.columnId = plan.columnId;
  } else {
    try {
      const fresh = fetchBoard(config);
      const freshCard = cardById(fresh, card.id);
      if (freshCard.id !== expectedCardId) {
        throw new GantusError('карточка не совпадает с id из preflight; перемещение отменено', 'conflict');
      }
      if (freshCard.taskKey !== key) {
        throw new GantusError('карточка с тем же id теперь имеет другой ключ; перемещение отменено', 'ambiguous');
      }
      if ((freshCard.desc ?? '') !== desc) {
        throw new GantusError('описание карточки изменилось после публикации; перемещение отменено', 'conflict');
      }
      assertAssignedTo(identity, freshCard);
      assertOwnedCard(identity, freshCard);
      if (freshCard.columnId !== card.columnId) {
        throw new GantusError('колонка карточки изменилась после публикации; перемещение отменено', 'conflict');
      }
      const freshPlan = reviewPlan(config, fresh, freshCard);
      if (freshPlan.kind === 'move') {
        moveCardToColumn(config, fresh, freshCard, freshPlan.target);
        try {
          const movedBoard = fetchBoard(config);
          const movedCard = cardById(movedBoard, card.id);
          if (movedCard.columnId !== freshPlan.target.id) {
            throw unconfirmedWrite('перемещение не подтверждено после записи');
          }
        } catch {
          throw unconfirmedWrite('перемещение не подтверждено после записи');
        }
        reviewMove = { moved: true, columnId: freshPlan.target.id };
      } else {
        reviewMove = { moved: false, reason: freshPlan.reason };
        if (freshPlan.columnId !== undefined) reviewMove.columnId = freshPlan.columnId;
      }
    } catch (error) {
      if (error instanceof GantusError) {
        const description = descriptionUpdated ? 'обновлено' : 'без изменений';
        const qaState = commented ? 'добавлен' : 'без изменений';
        const ambiguous = isAmbiguousWrite(error);
        const moveState = ambiguous
          ? 'результат перемещения не подтверждён'
          : 'карточка не перемещена';
        const combined = new GantusError(
          `описание ${description}; QA ${qaState}; ${error.message}; ${moveState}`,
          error.code
        );
        combined.ambiguous = ambiguous;
        throw combined;
      }
      throw error;
    }
  }

  return {
    synced: true,
    taskKey: key,
    mr: { iid: String(receipt.iid), operation: receipt.operation },
    description: { updated: descriptionUpdated },
    qa: { commented, deduplicated: ownQa },
    reviewMove
  };
}

export function startTask(config, flags) {
  const key = requiredValue(flags, 'key');
  const identity = verifyIdentity(config);
  const board = fetchBoard(config);
  const card = resolveCard(board, key);
  assertEditAllowed(identity, card);
  const source = statusColumn(board, 'todo', 'todo');
  const target = statusColumn(board, 'inprogress', 'inprogress');
  if (card.columnId === target.id) {
    return { moved: false, taskKey: key, columnId: target.id, reason: 'already' };
  }
  if (card.columnId !== source.id) {
    return { moved: false, taskKey: key, columnId: card.columnId, reason: 'source-not-allowed' };
  }
  moveCardToColumn(config, board, card, target);
  return {
    moved: true, taskKey: key, fromColumnId: source.id, columnId: target.id
  };
}

function columnById(board, id, label) {
  const matches = board.columns.filter((item) => item.id === id);
  if (matches.length === 0) {
    throw new GantusError(`${label} не найдена на настроенной доске`, 'not-found');
  }
  if (matches.length > 1) {
    throw new GantusError(`${label}: на доске несколько колонок с одним id`, 'protocol');
  }
  return matches[0];
}

function assertColumnStatus(column, expected, label) {
  if (column.status !== null && column.status !== '' && column.status !== expected) {
    throw new GantusError(`колонка ${label} имеет противоречащий статус; действие отменено`, 'ambiguous');
  }
}

function reviewSourceColumn(config, board) {
  if (config.reviewColumnId !== null) {
    const column = columnById(board, config.reviewColumnId, 'колонка ревью');
    assertColumnStatus(column, 'review', 'ревью');
    return column;
  }
  return statusColumn(board, 'review', 'review');
}

function testingTarget(config, board) {
  if (config.testingColumnId !== null) {
    const column = columnById(board, config.testingColumnId, 'колонка тестирования');
    assertColumnStatus(column, 'testing', 'тестирования');
    return column;
  }
  return statusColumn(board, 'testing', 'testing');
}

function numericId(value) {
  const parsed = typeof value === 'number'
    ? value
    : (typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : Number.NaN);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function requiredSha(flags, name) {
  const value = sha(requiredValue(flags, name));
  if (value === null) {
    throw new GantusError(`--${name}: ожидается SHA коммита`, 'usage');
  }
  return value;
}

function requiredDigest(flags, name) {
  const value = requiredValue(flags, name);
  if (!/^[0-9a-f]{64}$/i.test(value)) {
    throw new GantusError(`--${name}: ожидается SHA-256`, 'usage');
  }
  return value.toLowerCase();
}

function mrPin(config, flags) {
  const pin = parseMrUrl(requiredValue(flags, 'mr-url'));
  const expected = expectedMrUrl(config.gitRemote, pin.iid);
  if (!expected || pin.webUrl.replace(/\/+$/, '') !== expected.replace(/\/+$/, '')) {
    throw new GantusError('--mr-url не совпадает с проектом из GANTUS_GIT_REMOTE', 'ambiguous');
  }
  return pin;
}

function mrIdentity(mr, pin, pins) {
  if (!mr || typeof mr !== 'object') {
    throw new GantusError('GitLab вернул MR не в ожидаемом формате', 'protocol');
  }
  if (numericId(mr.iid) !== pin.iid) {
    throw new GantusError('MR iid не совпадает с проверенным; действие отменено', 'conflict');
  }
  const projects = [mr.project_id, mr.source_project_id, mr.target_project_id].map(numericId);
  if (projects.some((id) => id === null) || new Set(projects).size !== 1) {
    throw new GantusError('MR относится к другому проекту или fork; действие отменено', 'conflict');
  }
  if (projects[0] !== numericId(pins.projectId)) {
    throw new GantusError('MR разрешился в другой проект; действие отменено', 'conflict');
  }
  if (mr.source_branch !== pins.sourceBranch || mr.target_branch !== pins.targetBranch) {
    throw new GantusError('ветки MR не совпадают с проверенными; действие отменено', 'conflict');
  }
  if (typeof mr.web_url !== 'string' || mr.web_url.replace(/\/+$/, '') !== pin.webUrl) {
    throw new GantusError('MR web_url не совпадает с проверенным; действие отменено', 'conflict');
  }
}

function assertMergeableMr(mr, pin, pins) {
  mrIdentity(mr, pin, pins);
  if (mr.state !== 'opened') {
    throw new GantusError('MR уже не открыт; merge отменён', 'conflict');
  }
  if (mr.draft !== false) {
    throw new GantusError('MR Draft или draft не подтверждён; merge отменён', 'conflict');
  }
  const refs = mr.diff_refs;
  if (!refs || typeof refs !== 'object') {
    throw new GantusError('GitLab вернул MR без diff_refs; merge отменён', 'protocol');
  }
  if (sha(refs.base_sha) !== pins.baseSha || sha(refs.start_sha) !== pins.startSha
      || sha(refs.head_sha) !== pins.headSha) {
    throw new GantusError('ревизия MR изменилась после review; merge отменён', 'conflict');
  }
  if (mr.detailed_merge_status !== 'mergeable') {
    throw new GantusError('MR не в состоянии mergeable; merge отменён', 'conflict');
  }
  if (mr.blocking_discussions_resolved !== true) {
    throw new GantusError('в MR остаются блокирующие обсуждения; merge отменён', 'conflict');
  }
  if (mr.has_conflicts !== false) {
    throw new GantusError('MR имеет конфликты или это не подтверждено; merge отменён', 'conflict');
  }
  if (mr.force_remove_source_branch !== false) {
    throw new GantusError('настройка проекта удалит source branch; merge отменён', 'conflict');
  }
}

function assertMergedMr(mr, pin, pins) {
  mrIdentity(mr, pin, pins);
  if (mr.state !== 'merged') {
    throw new GantusError('MR не подтверждён как merged; действие отменено', 'conflict');
  }
  if (mr.draft !== false) {
    throw new GantusError('merged MR не должен быть Draft; действие отменено', 'conflict');
  }
  if (typeof mr.merged_at !== 'string' || Number.isNaN(Date.parse(mr.merged_at))) {
    throw new GantusError('MR не содержит подтверждённого времени merge', 'protocol');
  }
  const heads = [];
  if (mr.diff_refs !== undefined && mr.diff_refs !== null) {
    if (typeof mr.diff_refs !== 'object') {
      throw new GantusError('GitLab вернул некорректный diff_refs', 'protocol');
    }
    if (mr.diff_refs.head_sha !== undefined) heads.push(sha(mr.diff_refs.head_sha));
  }
  if (mr.sha !== undefined) heads.push(sha(mr.sha));
  if (heads.length === 0 || heads.some((value) => value === null || value !== pins.headSha)) {
    throw new GantusError('SHA источника не совпадает с проверенной ревизией; действие отменено', 'conflict');
  }
  if (mr.merge_commit_sha !== undefined && mr.merge_commit_sha !== null
      && sha(mr.merge_commit_sha) === null) {
    throw new GantusError('merge_commit_sha имеет некорректный формат', 'protocol');
  }
  if (mr.merge_user !== undefined && mr.merge_user !== null) {
    if (typeof mr.merge_user !== 'object') {
      throw new GantusError('GitLab вернул некорректного merge_user', 'protocol');
    }
    const merger = numericId(mr.merge_user.id);
    if (merger === null) {
      throw new GantusError('GitLab вернул некорректного merge_user', 'protocol');
    }
    if (String(merger) !== pins.gitlabUserId) {
      throw new GantusError('merge выполнен не текущим пользователем; действие отменено', 'auth');
    }
  }
}

function digest(value) {
  return createHash('sha256').update(value === null || value === undefined ? '' : String(value), 'utf8').digest('hex');
}

function mergeRoute(config, { key, cardId, nameSha256, descSha256 }) {
  const identity = verifyIdentity(config);
  const board = fetchBoard(config);
  const card = resolveCard(board, key);
  if (card.id !== cardId) {
    throw new GantusError('карточка не совпадает с id из проверки; merge отменён', 'conflict');
  }
  if (digest(card.name) !== nameSha256 || digest(card.desc) !== descSha256) {
    throw new GantusError('требования карточки изменились после review; merge отменён', 'conflict');
  }
  assertEditAllowed(identity, card);
  const source = reviewSourceColumn(config, board);
  const target = testingTarget(config, board);
  if (target.id === source.id) {
    throw new GantusError('колонки ревью и тестирования совпадают; merge отменён', 'ambiguous');
  }
  if (card.columnId !== source.id && card.columnId !== target.id) {
    throw new GantusError('карточка не в колонке ревью; merge отменён', 'conflict');
  }
  return { sourceId: source.id, targetId: target.id };
}

function moveAfterMerge(config, { key, cardId, sourceId, targetId, nameSha256, descSha256 }) {
  const identity = verifyIdentity(config);
  const board = fetchBoard(config);
  const keyed = board.cards.filter((card) => card.taskKey === key);
  if (keyed.length !== 1 || keyed[0].id !== cardId) {
    throw new GantusError('карточка с проверенным ключом заменена или продублирована; перемещение отменено', 'ambiguous');
  }
  const card = keyed[0];
  if (digest(card.name) !== nameSha256 || digest(card.desc) !== descSha256) {
    throw new GantusError('требования карточки изменились после review; перемещение отменено', 'conflict');
  }
  const source = reviewSourceColumn(config, board);
  const target = testingTarget(config, board);
  if (source.id !== sourceId || target.id !== targetId || target.id === source.id) {
    throw new GantusError('маршрут ревью или тестирования изменился; перемещение отменено', 'conflict');
  }
  if (card.columnId === target.id) {
    return { moved: false, reason: 'already', columnId: target.id };
  }
  if (card.columnId !== source.id) {
    return { moved: false, reason: 'column-changed', columnId: card.columnId };
  }
  assertEditAllowed(identity, card);
  moveCardToColumn(config, board, card, target);
  try {
    const after = fetchBoard(config);
    const afterCard = cardById(after, cardId);
    const afterKeyed = after.cards.filter((item) => item.taskKey === key);
    if (afterKeyed.length !== 1 || afterCard.taskKey !== key || afterCard.columnId !== target.id) {
      throw unconfirmedWrite('перемещение не подтверждено после записи');
    }
  } catch {
    throw unconfirmedWrite('перемещение не подтверждено после записи');
  }
  return { moved: true, columnId: target.id };
}

function mergePins(flags) {
  const gitlabUserId = requiredValue(flags, 'gitlab-user-id');
  if (!/^\d+$/.test(gitlabUserId)) {
    throw new GantusError('--gitlab-user-id: ожидается числовой id пользователя', 'usage');
  }
  const projectId = numericId(requiredValue(flags, 'project-id'));
  if (projectId === null) {
    throw new GantusError('--project-id: ожидается числовой id проекта', 'usage');
  }
  return { gitlabUserId, projectId };
}

export function reviewMerge(config, flags, cwd) {
  const key = requiredValue(flags, 'key');
  const cardId = requiredValue(flags, 'card-id');
  if (!isId(cardId)) {
    throw new GantusError('--card-id: некорректный id', 'usage');
  }
  const pins = {
    ...mergePins(flags),
    sourceBranch: requiredValue(flags, 'source-branch'),
    targetBranch: requiredValue(flags, 'target-branch'),
    baseSha: requiredSha(flags, 'base-sha'),
    startSha: requiredSha(flags, 'start-sha'),
    headSha: requiredSha(flags, 'head-sha')
  };
  const nameSha256 = requiredDigest(flags, 'name-sha256');
  const descSha256 = requiredDigest(flags, 'desc-sha256');
  assertProjectRemote(config, cwd);
  const pin = mrPin(config, flags);
  singleTaskKey(pins.sourceBranch, key);
  mergeRoute(config, { key, cardId, nameSha256, descSha256 });
  assertUnresolvedDiscussions(fetchDiscussions(pin));
  const route = mergeRoute(config, { key, cardId, nameSha256, descSha256 });
  assertMergeableMr(fetchMr(pin), pin, pins);

  let confirmed = null;
  let ambiguousTransport = false;
  try {
    const receipt = requestMerge(pin, {
      sha: pins.headSha,
      should_remove_source_branch: false
    });
    if (receipt !== null) {
      try {
        assertMergedMr(receipt, pin, pins);
        confirmed = receipt;
      } catch {
        confirmed = null;
      }
    }
  } catch (error) {
    if (!error.verify) throw error;
    ambiguousTransport = error.ambiguous === true;
  }
  if (confirmed === null) {
    let fetched;
    try {
      fetched = fetchMr(pin);
      assertMergedMr(fetched, pin, pins);
    } catch (error) {
      if (!ambiguousTransport) throw error;
      throw new GantusError(
        'результат merge не подтверждён; дальнейшая проверка — только read-only post-merge',
        'conflict'
      );
    }
    confirmed = fetched;
    if (ambiguousTransport) {
      return {
        merged: true,
        taskKey: key,
        mr: { iid: String(pin.iid), sha: pins.headSha },
        testMove: { moved: false, reason: 'ambiguous-merge' }
      };
    }
  }
  let testMove;
  try {
    testMove = moveAfterMerge(config, {
      key, cardId, ...route, nameSha256, descSha256
    });
  } catch (error) {
    if (!(error instanceof GantusError)) throw error;
    testMove = { moved: false, reason: isAmbiguousWrite(error) ? 'unconfirmed' : 'failed' };
  }
  return {
    merged: true,
    taskKey: key,
    mr: { iid: String(pin.iid), sha: pins.headSha },
    testMove
  };
}

export function postMerge(config, flags, cwd) {
  const key = requiredValue(flags, 'key');
  const cardId = requiredValue(flags, 'card-id');
  if (!isId(cardId)) {
    throw new GantusError('--card-id: некорректный id', 'usage');
  }
  const pins = {
    ...mergePins(flags),
    sourceBranch: requiredValue(flags, 'source-branch'),
    targetBranch: requiredValue(flags, 'expected-target-branch'),
    headSha: requiredSha(flags, 'expected-sha')
  };
  assertProjectRemote(config, cwd);
  const pin = mrPin(config, flags);
  singleTaskKey(pins.sourceBranch, key);
  verifyIdentity(config);
  const board = fetchBoard(config);
  const card = resolveCard(board, key);
  if (card.id !== cardId) {
    throw new GantusError('карточка не совпадает с id из проверки; сверка отменена', 'conflict');
  }
  assertMergedMr(fetchMr(pin), pin, pins);
  const column = board.columns.find((item) => item.id === card.columnId);
  return {
    merged: true,
    taskKey: key,
    mr: { iid: String(pin.iid), sha: pins.headSha },
    card: {
      id: card.id,
      columnId: card.columnId,
      column: column?.name ?? null,
      status: card.status
    }
  };
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
  if (command === 'start') return startTask(config, flags);
  if (command === 'edit') return editTask(config, flags);
  if (command === 'comment') return commentTask(config, flags);
  if (command === 'move') return moveTask(config, flags);
  if (command === 'preflight') return preflightTask(config, flags, cwd);
  if (command === 'review-lookup') return reviewLookup(config, flags, cwd);
  if (command === 'review-ready') return reviewReady(config, flags, cwd);
  if (command === 'sync') return syncTask(config, flags, cwd);
  if (command === 'post-merge') return postMerge(config, flags, cwd);
  if (command === 'review-merge') return reviewMerge(config, flags, cwd);
  if (command === 'rename-branch') return renameBranch(config, flags, cwd);
  throw new GantusError('неизвестная команда', 'usage');
}
