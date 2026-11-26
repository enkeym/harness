#!/usr/bin/env node
// GitLab API: существующая glab-сессия или токен окружения, без login и утечек argv.
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';

const TIMEOUT_MS = 90_000;
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
const JSON_CONTENT_TYPE_HEADER = 'Content-Type: application/json';
const DEFINITE_HTTP = new Set(['400', '401', '403', '404', '405', '409', '422']);
const args = process.argv.slice(2);
let host, input;
let method = 'GET';
let singleAttempt = false;
const endpoints = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--hostname') host = args[++i];
  else if (args[i] === '--method') method = args[++i];
  else if (args[i] === '--input') input = args[++i];
  else if (args[i] === '--single-attempt') singleAttempt = true;
  else endpoints.push(args[i]);
}

function fail(message) {
  console.error(`GitLab API: ${message}`);
  process.exit(1);
}

if (!host || !/^[a-zA-Z0-9.-]+(?::\d+)?$/.test(host) || endpoints.length !== 1
    || !/^(GET|POST|PUT|PATCH|DELETE)$/.test(method || '')
    || !/^[a-zA-Z0-9_]/.test(endpoints[0]) || endpoints[0].includes('://')
    || /[\r\n#]/.test(endpoints[0])) {
  fail('usage: gitlab-api.mjs --hostname HOST [--method METHOD] [--input JSON_FILE] ENDPOINT');
}
if (input) {
  try { JSON.parse(fs.readFileSync(input, 'utf8')); }
  catch { fail('--input должен указывать на читаемый JSON-файл'); }
}
const token = process.env.GITLAB_TOKEN || process.env.GLAB_TOKEN || process.env.GITLAB_ACCESS_TOKEN;
if (token && /[\r\n]/.test(token)) fail('некорректный формат токена окружения');
const options = { encoding: 'utf8', timeout: TIMEOUT_MS, maxBuffer: MAX_RESPONSE_BYTES };

function output(body) {
  try { console.log(JSON.stringify(body.trim() ? JSON.parse(body) : null)); }
  catch { fail('сервер вернул ответ не в формате JSON'); }
}

function includedResponse(text) {
  const statusLine = /^HTTP\/\d(?:\.\d)?[ \t]+(\d{3})\b[^\r\n]*(?:\r\n|\n)/.exec(text);
  if (!statusLine) return null;
  const status = Number(statusLine[1]);
  const rest = text.slice(statusLine[0].length);
  if (rest.startsWith('\r\n')) return { status, body: rest.slice(2) };
  if (rest.startsWith('\n')) return { status, body: rest.slice(1) };
  const headersEnd = /\r?\n\r?\n/.exec(rest);
  if (headersEnd) return { status, body: rest.slice(headersEnd.index + headersEnd[0].length) };
  return { status, body: '', malformed: true };
}

if (token) {
  const url = `https://${host}/api/v4/${endpoints[0]}`;
  const curl = spawnSync('curl', ['-q', '--globoff', '--silent', '--show-error',
    '--connect-timeout', '10', '--max-time', '60', '--header', '@-', '--request', method,
    ...(input ? ['--header', JSON_CONTENT_TYPE_HEADER, '--data-binary', `@${input}`] : []),
    '--write-out', '\n%{http_code}', url], { ...options, input: `PRIVATE-TOKEN: ${token}\n` });
  if (curl.error || curl.status !== 0) {
    fail(method === 'GET'
      ? 'ошибка сети или таймаут curl; GET не выполнен'
      : 'результат записи неизвестен, повтор запрещён');
  }
  const split = curl.stdout.lastIndexOf('\n');
  const status = Number(curl.stdout.slice(split + 1));
  if (split < 0 || !Number.isInteger(status)) {
    fail(method === 'GET'
      ? 'некорректный HTTP-статус ответа; GET не выполнен'
      : 'некорректный HTTP-статус ответа; результат записи неизвестен, повтор запрещён');
  }
  if (status < 200 || status >= 300) {
    if (DEFINITE_HTTP.has(String(status))) {
      fail(`HTTP ${status}: запрос не выполнен`);
    }
    fail(method === 'GET'
      ? `HTTP ${status}: GET не выполнен`
      : `HTTP ${status}: результат записи неизвестен, повтор запрещён`);
  }
  output(curl.stdout.slice(0, split));
  process.exit(0);
}

const glab = spawnSync('glab', ['api', '--hostname', host, '--method', method,
  ...(singleAttempt ? ['--include'] : []),
  ...(input ? ['--input', input, '--header', JSON_CONTENT_TYPE_HEADER] : []), endpoints[0]], options);
if (['ENOENT', 'EACCES'].includes(glab.error?.code)) fail('glab недоступен; токен окружения отсутствует');
if (singleAttempt) {
  if (glab.error?.code === 'ETIMEDOUT') {
    fail('таймаут; результат запроса неизвестен, повтор запрещён');
  }
  const included = includedResponse(glab.stdout);
  if (!included) {
    fail(method === 'GET'
      ? 'glab не вернул HTTP-статус; GET не выполнен'
      : 'glab не вернул HTTP-статус; результат записи неизвестен, повтор запрещён');
  }
  if (included.status < 200 || included.status >= 300) {
    if (DEFINITE_HTTP.has(String(included.status))) {
      if (included.status === 401) fail('HTTP 401: авторизация отклонена');
      if (included.status === 403) fail('HTTP 403: недостаточно прав');
      fail(`HTTP ${included.status}: запрос отклонён сервером`);
    }
    fail(method === 'GET'
      ? `HTTP ${included.status}: GET не выполнен`
      : `HTTP ${included.status}: результат записи неизвестен, повтор запрещён`);
  }
  if (included.malformed) {
    fail(method === 'GET'
      ? 'некорректный HTTP-ответ; GET не выполнен'
      : 'некорректный HTTP-ответ; результат записи неизвестен, повтор запрещён');
  }
  if (glab.error || glab.status !== 0) {
    fail(method === 'GET'
      ? 'процесс glab завершился с ошибкой; GET не выполнен'
      : 'процесс glab завершился с ошибкой; результат записи неизвестен, повтор запрещён');
  }
  output(included.body);
  process.exit(0);
}
if (!glab.error && glab.status === 0) {
  output(glab.stdout);
  process.exit(0);
}
const problem = String(glab.stderr || '');
// Повтор записи после таймаута или ответа сервера может создать дубликат.
if (glab.error?.code === 'ETIMEDOUT') fail('таймаут; результат записи неизвестен, не повторяй POST вслепую');
if (/\b401\b/.test(problem)) fail('HTTP 401: авторизация отклонена');
if (/\b403\b/.test(problem)) fail('HTTP 403: недостаточно прав');
if (/read-only file system|permission denied|failed to read configuration/i.test(problem)) {
  fail('glab не может открыть конфигурацию в этой среде; это не признак истёкшей сессии. Токен окружения отсутствует');
}
if (/resolve|lookup|connect|network|dial tcp/i.test(problem)) fail('сетевая ошибка; существующая авторизация не сбрасывалась');
fail('запрос glab не выполнен; проверь доступность клиента и авторизацию нужного host. Автоматический login не выполняется');
