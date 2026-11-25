import { GantusError } from './config.mjs';
import { request, safeId } from './http.mjs';

const BOOTSTRAP_LIMIT_BYTES = 16 * 1024 * 1024;

export function verifyIdentity(config) {
  const data = request(config, { method: 'GET', path: '/api/auth/me' });
  if (!data || typeof data !== 'object' || data.id !== config.userId) {
    throw new GantusError('учётная запись не совпадает с настроенным GANTUS_USER_ID', 'auth');
  }
  return {
    id: data.id,
    employeeId: typeof data.employeeId === 'string' ? data.employeeId : null,
    role: typeof data.role === 'string' ? data.role : ''
  };
}

function text(value) {
  return typeof value === 'string' ? value : null;
}

function number(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function fetchBootstrap(config) {
  const payload = request(config, {
    method: 'GET', path: '/api/data/bootstrap', maxBytes: BOOTSTRAP_LIMIT_BYTES
  });
  if (!payload || typeof payload !== 'object'
      || !Array.isArray(payload.departments) || !Array.isArray(payload.tasks)) {
    throw new GantusError('сервер не вернул bootstrap с отделами и задачами', 'protocol');
  }
  return payload;
}

function taskKey(task, department) {
  if (!task) return null;
  if (typeof task.taskKey === 'string' && task.taskKey !== '') return task.taskKey;
  if (!Number.isSafeInteger(task.taskNumber) || task.taskNumber <= 0) return null;
  if (!department || typeof department.tag !== 'string' || department.tag === '') return null;
  return `${department.tag}-${task.taskNumber}`;
}

export function fetchBoard(config, { withTasks = true } = {}) {
  const bootstrap = withTasks ? fetchBootstrap(config) : null;
  const payload = request(config, {
    method: 'GET',
    path: `/api/kanban/boards/${encodeURIComponent(config.teamId)}`
  });
  const rawBoard = payload?.board;
  if (!rawBoard || typeof rawBoard !== 'object') {
    throw new GantusError('сервер не вернул настроенную доску', 'protocol');
  }
  if (typeof rawBoard.id !== 'string' || typeof rawBoard.deptId !== 'string'
      || typeof rawBoard.teamName !== 'string' || !rawBoard.teamName.trim() || rawBoard.teamId !== config.teamId) {
    throw new GantusError('ответ доски не совпадает с настроенной командой', 'protocol');
  }
  if (!Array.isArray(payload.columns) || !Array.isArray(payload.cards)) {
    throw new GantusError('сервер вернул доску без колонок или карточек', 'protocol');
  }

  const columns = payload.columns.map((column) => {
    if (!column || typeof column !== 'object') {
      throw new GantusError('сервер вернул некорректную колонку', 'protocol');
    }
    const boardId = safeId(column.boardId, 'доска колонки');
    if (boardId !== rawBoard.id) {
      throw new GantusError('колонка принадлежит другой доске', 'protocol');
    }
    return {
      id: safeId(column.id, 'колонка'),
      boardId,
      status: text(column.status),
      name: text(column.name)
    };
  });
  const columnIds = new Set(columns.map((column) => column.id));
  if (columnIds.size !== columns.length) {
    throw new GantusError('сервер вернул повторяющиеся колонки', 'protocol');
  }

  const department = bootstrap?.departments.find((item) => item?.id === rawBoard.deptId);
  const comments = department?.teamComments;
  const commentsEnabled = Object.hasOwn(comments ?? {}, rawBoard.teamName) && comments[rawBoard.teamName] === true;
  const tasks = new Map();
  for (const task of bootstrap?.tasks ?? []) {
    if (!task || typeof task !== 'object' || typeof task.id !== 'string') continue;
    if (task.dept !== rawBoard.deptId || task.team !== rawBoard.teamName) continue;
    if (tasks.has(task.id)) throw new GantusError('сервер вернул несколько задач с одним id', 'protocol');
    tasks.set(task.id, task);
  }

  const cards = [];
  const cardIds = new Set();
  for (const entry of payload.cards) {
    if (!entry || typeof entry !== 'object') continue;
    const columnId = entry.columnId;
    if (typeof columnId !== 'string' || !columnIds.has(columnId)) continue;
    const id = safeId(entry.id, 'карточка');
    if (cardIds.has(id)) throw new GantusError('сервер вернул несколько карточек с одним id', 'protocol');
    cardIds.add(id);
    const task = tasks.get(id);
    cards.push({
      id,
      columnId,
      order: number(entry.order),
      taskKey: taskKey(task, department),
      name: text(task?.name),
      desc: text(task?.desc),
      status: text(entry.status ?? task?.status),
      priority: text(task?.priority),
      assignee: text(task?.assignee),
      creatorUserId: task?.creatorUserId ?? null,
      editProtected: task?.editProtected !== false,
      commentsEnabled
    });
  }

  return {
    id: safeId(rawBoard.id, 'доска'),
    deptId: rawBoard.deptId,
    teamId: rawBoard.teamId,
    teamName: rawBoard.teamName,
    columns,
    cards
  };
}

export function resolveCard(board, key) {
  if (typeof key !== 'string' || key === '') {
    throw new GantusError('не указан ключ задачи', 'usage');
  }
  const matches = board.cards.filter((card) => card.taskKey === key);
  if (matches.length === 0) {
    throw new GantusError(`задача ${key} не найдена в настроенной доске`, 'not-found');
  }
  if (matches.length > 1) {
    throw new GantusError(`в настроенной доске несколько карточек с ключом ${key}; запись отменена`, 'ambiguous');
  }
  return matches[0];
}

export function reviewColumn(board) {
  const matches = board.columns.filter((column) => column.status === 'review');
  if (matches.length === 0) {
    throw new GantusError('в настроенной доске нет колонки со статусом review', 'ambiguous');
  }
  if (matches.length > 1) {
    throw new GantusError('в настроенной доске несколько колонок со статусом review; перенос отменён', 'ambiguous');
  }
  return matches[0];
}

export function taskId(card) {
  return safeId(card.id, 'задача');
}

export function assertEditAllowed(identity, card) {
  if (!card.editProtected || identity.role === 'admin') return;
  const creator = card.creatorUserId === null ? null : String(card.creatorUserId);
  if (creator !== null && creator === String(identity.id)) return;
  if (identity.employeeId !== null && card.assignee === identity.employeeId) return;
  throw new GantusError('правка недоступна: нужен admin, автор задачи или исполнитель', 'auth');
}

export function assertCommentAllowed(card) {
  if (!card.commentsEnabled) {
    throw new GantusError('комментарии отключены для команды этой задачи', 'auth');
  }
}
