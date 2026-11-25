import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { GantusError, isId } from './config.mjs';

const CONNECT_TIMEOUT_SECONDS = 10;
const MAX_TIME_SECONDS = 60;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

export function safeId(value, label) {
  if (!isId(value)) {
    throw new GantusError(`сервер вернул некорректный идентификатор: ${label}`, 'protocol');
  }
  return value;
}

function failure(message, code, ambiguous) {
  const error = new GantusError(
    ambiguous ? `${message}; результат записи неизвестен, не повторяй запрос` : message,
    code
  );
  error.ambiguous = ambiguous;
  return error;
}

export function request(config, {
  method, path: requestPath, json, mutation = false, maxBytes = MAX_RESPONSE_BYTES
}) {
  if (typeof requestPath !== 'string' || !requestPath.startsWith('/') || requestPath.startsWith('//')) {
    throw new GantusError('внутренний некорректный путь запроса', 'protocol');
  }
  const url = new URL(requestPath, `${config.origin}/`);
  if (url.origin !== config.origin || url.pathname !== requestPath) {
    throw new GantusError('внутренний некорректный адрес запроса', 'protocol');
  }

  let directory = null;

  try {
    let bodyFile = null;
    if (json !== undefined) {
      directory = fs.mkdtempSync(path.join(os.tmpdir(), 'gantus-body-'));
      bodyFile = path.join(directory, 'body');
      fs.writeFileSync(bodyFile, JSON.stringify(json), { mode: 0o600, flag: 'wx' });
    }
    const args = [
      '-q',
      '--silent',
      '--show-error',
      '--globoff',
      '--compressed',
      '--connect-timeout',
      String(CONNECT_TIMEOUT_SECONDS),
      '--max-time',
      String(MAX_TIME_SECONDS),
      '--max-filesize',
      String(maxBytes),
      '--max-redirs',
      '0',
      '--noproxy',
      '*',
      '--proto',
      config.protocol === 'http:' ? '=http' : '=https',
      '--header',
      '@-',
      '--request',
      method,
      '--write-out',
      '\n%{http_code}'
    ];
    if (bodyFile !== null) {
      args.push('--header', 'Content-Type: application/json', '--data-binary', `@${bodyFile}`);
    }
    args.push(url.toString());

    const headers = [
      `Cookie: ${config.cookie}`,
      'Accept: application/json',
      `X-Client-Id: ${randomUUID()}`
    ].join('\n');
    const result = spawnSync('curl', args, {
      encoding: 'utf8',
      timeout: (MAX_TIME_SECONDS + 10) * 1000,
      maxBuffer: maxBytes + 65536,
      input: `${headers}\n`
    });

    if (result.error) {
      if (result.error.code === 'ENOENT') {
        throw new GantusError('curl не найден', 'network');
      }
      if (result.error.code === 'ENOBUFS') {
        throw failure('ответ сервера превысил допустимый размер', 'network', mutation);
      }
      throw failure('сетевая ошибка или таймаут curl', 'network', mutation);
    }
    if (result.status === 63) {
      throw failure('ответ сервера превысил допустимый размер', 'network', mutation);
    }
    if (result.status !== 0) {
      throw failure('curl завершился с ошибкой', 'network', mutation);
    }

    const split = result.stdout.lastIndexOf('\n');
    const status = Number(result.stdout.slice(split + 1));
    if (split < 0 || !Number.isInteger(status)) {
      throw failure('сервер вернул некорректный HTTP-статус', 'network', mutation);
    }
    const text = result.stdout.slice(0, split);

    if (status < 200 || status >= 300) {
      if (status === 401) {
        throw new GantusError('HTTP 401: сессия не принята; обнови GANTUS_SESSION_COOKIE', 'auth');
      }
      if (status === 403) throw new GantusError('HTTP 403: недостаточно прав', 'auth');
      if (status === 404) throw new GantusError('HTTP 404: ресурс не найден', 'http');
      if (status === 409) throw new GantusError('HTTP 409: конфликт состояния', 'http');
      if (status >= 500 && mutation) {
        throw failure(`HTTP ${status}: сервер не подтвердил результат`, 'http', true);
      }
      throw new GantusError(`HTTP ${status}: запрос не выполнен`, 'http');
    }

    if (text.trim() === '') return null;
    try {
      return JSON.parse(text);
    } catch {
      throw failure('сервер вернул ответ не в формате JSON', 'protocol', mutation);
    }
  } finally {
    if (directory !== null) fs.rmSync(directory, { recursive: true, force: true });
  }
}
