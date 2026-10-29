#!/usr/bin/env node
// GitLab API: существующая glab-сессия или токен окружения, без login и утечек argv.
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';

const TIMEOUT_MS = 90_000;
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
const args = process.argv.slice(2);
let host, input;
let method = 'GET';
const endpoints = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--hostname') host = args[++i];
  else if (args[i] === '--method') method = args[++i];
  else if (args[i] === '--input') input = args[++i];
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
const glab = spawnSync('glab', ['api', '--hostname', host, '--method', method,
  ...(input ? ['--input', input] : []), endpoints[0]], options);

function output(body) {
  try { console.log(JSON.stringify(body.trim() ? JSON.parse(body) : null)); }
  catch { fail('сервер вернул ответ не в формате JSON'); }
}

if (!glab.error && glab.status === 0) {
  output(glab.stdout);
  process.exit(0);
}
const problem = String(glab.stderr || '');
// Повтор записи после таймаута или ответа сервера может создать дубликат.
const httpFailure = /HTTP[ /:]*(?:[45]\d\d)/i.test(problem);
const localFailure = !httpFailure && (['ENOENT', 'EACCES'].includes(glab.error?.code)
  || /failed to read configuration|read-only file system|permission denied|not logged into|no token provided|not authenticated/i.test(problem));
if (!localFailure || !token) {
  if (glab.error?.code === 'ETIMEDOUT') fail('таймаут; результат записи неизвестен, не повторяй POST вслепую');
  if (/\b401\b/.test(problem)) fail('HTTP 401: авторизация отклонена');
  if (/\b403\b/.test(problem)) fail('HTTP 403: недостаточно прав');
  if (/read-only file system|permission denied|failed to read configuration/i.test(problem)) {
    fail('glab не может открыть конфигурацию в этой среде; это не признак истёкшей сессии. Токен окружения отсутствует');
  }
  if (/resolve|lookup|connect|network|dial tcp/i.test(problem)) fail('сетевая ошибка; существующая авторизация не сбрасывалась');
  fail('запрос glab не выполнен; проверь доступность клиента и авторизацию нужного host. Автоматический login не выполняется');
}
const url = `https://${host}/api/v4/${endpoints[0]}`;
const curl = spawnSync('curl', ['--silent', '--show-error', '--connect-timeout', '10',
  '--max-time', '60', '--header', '@-', '--request', method,
  ...(input ? ['--header', 'Content-Type: application/json', '--data-binary', `@${input}`] : []),
  '--write-out', '\n%{http_code}', url], { ...options, input: `PRIVATE-TOKEN: ${token}\n` });
if (curl.error || curl.status !== 0) fail('ошибка сети или таймаут curl; запись автоматически не повторяется');
const split = curl.stdout.lastIndexOf('\n');
const status = Number(curl.stdout.slice(split + 1));
if (split < 0 || status < 200 || status >= 300 || !Number.isInteger(status)) {
  fail(`HTTP ${status || 'unknown'}: запрос не выполнен`);
}
output(curl.stdout.slice(0, split));
