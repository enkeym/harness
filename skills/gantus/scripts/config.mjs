export class GantusError extends Error {
  constructor(message, code = 'gantus') {
    super(message);
    this.name = 'GantusError';
    this.code = code;
    this.ambiguous = false;
  }
}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);
const PRIVATE_IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
const RESOURCE_ID = /^[A-Za-z0-9_-]{1,128}$/;

export function isId(value) {
  return typeof value === 'string' && RESOURCE_ID.test(value);
}

function isPrivateIPv4(hostname) {
  const match = PRIVATE_IPV4.exec(hostname);
  if (!match) return false;
  const octets = match.slice(1).map(Number);
  if (octets.some((octet) => octet > 255)) return false;
  const [first, second] = octets;
  return first === 10
    || (first === 172 && second >= 16 && second <= 31)
    || (first === 192 && second === 168);
}

function assertHttpOriginAllowed(url, env) {
  if (!isPrivateIPv4(url.hostname)) {
    throw new GantusError('GANTUS_BASE_URL: незашифрованный HTTP разрешён только для loopback или приватного IPv4 (RFC1918) с GANTUS_ALLOW_HTTP_ORIGIN', 'config');
  }
  const allowedOrigin = required(env, 'GANTUS_ALLOW_HTTP_ORIGIN');
  let allowed;
  try {
    allowed = new URL(allowedOrigin);
  } catch {
    throw new GantusError('GANTUS_ALLOW_HTTP_ORIGIN: некорректный URL', 'config');
  }
  if (allowed.protocol !== 'http:'
    || allowed.username || allowed.password
    || allowed.search || allowed.hash
    || (allowed.pathname !== '/' && allowed.pathname !== '')) {
    throw new GantusError('GANTUS_ALLOW_HTTP_ORIGIN: ожидается HTTP origin без пути и учётных данных', 'config');
  }
  if (allowed.origin !== url.origin) {
    throw new GantusError('GANTUS_ALLOW_HTTP_ORIGIN: origin не совпадает с GANTUS_BASE_URL', 'config');
  }
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

function optionalIdList(env, name) {
  const value = env[name];
  if (value === undefined) return null;
  if (typeof value !== 'string' || value.trim() === '' || /[\r\n]/.test(value)) {
    throw new GantusError(`некорректное значение: ${name}`, 'config');
  }
  const ids = value.split(',').map((item) => item.trim());
  if (ids.some((id) => !isId(id)) || new Set(ids).size !== ids.length) {
    throw new GantusError(`${name}: ожидается список уникальных идентификаторов колонок`, 'config');
  }
  return Object.freeze(ids);
}

function optionalColumnId(env, name) {
  const value = env[name];
  if (value === undefined) return null;
  if (!isId(value)) {
    throw new GantusError(`${name}: недопустимый идентификатор колонки`, 'config');
  }
  return value;
}

export function loadOptionalConfig(env = process.env) {
  const requiredNames = ['GANTUS_BASE_URL', 'GANTUS_TEAM_ID', 'GANTUS_SESSION_COOKIE', 'GANTUS_USER_ID'];
  const configured = requiredNames.some((name) => env[name] !== undefined);
  return configured ? loadConfig(env) : null;
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
    assertHttpOriginAllowed(url, env);
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
  const reviewColumnId = optionalColumnId(env, 'GANTUS_REVIEW_COLUMN_ID');
  const reviewFromColumnIds = optionalIdList(env, 'GANTUS_REVIEW_FROM_COLUMN_IDS');
  if ((reviewColumnId === null) !== (reviewFromColumnIds === null)) {
    throw new GantusError(
      'GANTUS_REVIEW_COLUMN_ID и GANTUS_REVIEW_FROM_COLUMN_IDS задаются вместе', 'config'
    );
  }
  const testing = optionalColumnId(env, 'GANTUS_TESTING_COLUMN_ID');

  return Object.freeze({
    origin: url.origin,
    protocol: url.protocol,
    teamId,
    cookie,
    userId,
    gitRemote: gitRemote === undefined ? null : gitRemote,
    reviewColumnId,
    reviewFromColumnIds,
    testingColumnId: testing
  });
}
