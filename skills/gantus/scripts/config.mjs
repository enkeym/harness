export class GantusError extends Error {
  constructor(message, code = 'gantus') {
    super(message);
    this.name = 'GantusError';
    this.code = code;
  }
}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);
const RESOURCE_ID = /^[A-Za-z0-9_-]{1,128}$/;

export function isId(value) {
  return typeof value === 'string' && RESOURCE_ID.test(value);
}

function required(env, name) {
  const value = env[name];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new GantusError(`не настроено: ${name}`, 'config');
  }
  if (/[\r\n]/.test(value)) {
    throw new GantusError(`некорректное значение: ${name}`, 'config');
  }
  return value;
}

export function loadConfig(env = process.env) {
  const baseUrl = required(env, 'GANTUS_BASE_URL');
  let url;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new GantusError('GANTUS_BASE_URL: некорректный URL', 'config');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new GantusError('GANTUS_BASE_URL: нужен HTTPS origin', 'config');
  }
  if (url.protocol === 'http:' && !LOOPBACK_HOSTS.has(url.hostname)) {
    throw new GantusError('GANTUS_BASE_URL: незашифрованный HTTP разрешён только для loopback', 'config');
  }
  if (url.username || url.password) {
    throw new GantusError('GANTUS_BASE_URL: URL не должен содержать учётные данные', 'config');
  }
  if (url.search || url.hash) {
    throw new GantusError('GANTUS_BASE_URL: URL не должен содержать query или fragment', 'config');
  }
  if (url.pathname !== '/' && url.pathname !== '') {
    throw new GantusError('GANTUS_BASE_URL: нужен origin без пути', 'config');
  }

  const teamId = required(env, 'GANTUS_TEAM_ID');
  if (!isId(teamId)) {
    throw new GantusError('GANTUS_TEAM_ID: недопустимый идентификатор доски', 'config');
  }
  const cookie = required(env, 'GANTUS_SESSION_COOKIE');
  if (!/^[\x20-\x7e]+$/.test(cookie) || !cookie.includes('=')) {
    throw new GantusError('GANTUS_SESSION_COOKIE: ожидалась пара cookie name=value', 'config');
  }
  const userId = Number(required(env, 'GANTUS_USER_ID'));
  if (!Number.isSafeInteger(userId) || userId <= 0) {
    throw new GantusError('GANTUS_USER_ID: ожидается числовой id пользователя', 'config');
  }
  const gitRemote = env.GANTUS_GIT_REMOTE;
  if (gitRemote !== undefined && (/[\r\n]/.test(gitRemote) || gitRemote.trim() === '')) {
    throw new GantusError('GANTUS_GIT_REMOTE: некорректное значение', 'config');
  }

  return Object.freeze({
    origin: url.origin,
    protocol: url.protocol,
    teamId,
    cookie,
    userId,
    gitRemote: gitRemote === undefined ? null : gitRemote
  });
}
