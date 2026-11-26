import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { GantusError } from './config.mjs';

const API_CLI = path.resolve(import.meta.dirname, '../../../bin/gitlab-api.mjs');
const SHA40 = /^[0-9a-f]{40}$/i;
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);
const MAX_PAGES = 50;
const PER_PAGE = 100;

function failure(message, code, { ambiguous = false, verify = false } = {}) {
  const error = new GantusError(
    ambiguous ? `${message}; не повторяй запрос` : message,
    code
  );
  error.ambiguous = ambiguous;
  error.verify = verify;
  return error;
}

export function parseMrUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new GantusError('--mr-url: некорректный URL MR', 'usage');
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new GantusError('--mr-url: URL MR не должен содержать учётные данные, query или fragment', 'usage');
  }
  if (url.protocol === 'http:' && !LOOPBACK.has(url.hostname)) {
    throw new GantusError('--mr-url: нужен HTTPS URL MR', 'usage');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new GantusError('--mr-url: нужен HTTPS URL MR', 'usage');
  }
  const match = /^\/(.+)\/-\/merge_requests\/(\d+)\/?$/.exec(url.pathname);
  if (!match) {
    throw new GantusError('--mr-url: не удалось выделить проект и iid', 'usage');
  }
  let project;
  try {
    project = decodeURIComponent(match[1]);
  } catch {
    throw new GantusError('--mr-url: некорректный путь проекта', 'usage');
  }
  const iid = Number(match[2]);
  if (project === '' || project.startsWith('/') || project.includes('//')
      || !Number.isSafeInteger(iid) || iid <= 0) {
    throw new GantusError('--mr-url: некорректный проект или iid', 'usage');
  }
  return { host: url.host, project, iid, webUrl: `${url.origin}/${project}/-/merge_requests/${iid}` };
}

export function mrEndpoint(project, iid, suffix = '') {
  return `projects/${encodeURIComponent(project)}/merge_requests/${iid}${suffix}`;
}

export function gitlabRequest({ host, method = 'GET', endpoint, json, mutation = false }) {
  const args = [API_CLI, '--hostname', host, '--method', method];
  if (mutation) args.push('--single-attempt');
  let directory = null;
  try {
    if (json !== undefined) {
      directory = fs.mkdtempSync(path.join(os.tmpdir(), 'gitlab-body-'));
      const file = path.join(directory, 'body');
      fs.writeFileSync(file, JSON.stringify(json), { mode: 0o600, flag: 'wx' });
      args.push('--input', file);
    }
    args.push(endpoint);
    const result = spawnSync(process.execPath, args, {
      encoding: 'utf8',
      timeout: 100_000,
      maxBuffer: 16 * 1024 * 1024
    });
    if (result.error) {
      throw failure('не удалось запустить клиент GitLab API', 'network', { ambiguous: mutation });
    }
    const problem = String(result.stderr || '').trim();
    if (result.status !== 0) {
      const code = /GitLab API: HTTP (\d{3})\b/.exec(problem)?.[1];
      if (code && ['400', '401', '403', '404', '405', '409', '422'].includes(code)) {
        throw new GantusError(`GitLab HTTP ${code}: запрос отклонён`, code === '401' || code === '403' ? 'auth' : 'http');
      }
      if (/ответ не в формате JSON/i.test(problem)) {
        throw failure('GitLab вернул ответ не в формате JSON', 'protocol', { verify: mutation });
      }
      throw failure(problem || 'клиент GitLab API завершился с ошибкой', 'network', {
        ambiguous: mutation, verify: mutation
      });
    }
    const text = String(result.stdout || '').trim();
    if (text === '') return null;
    try {
      return JSON.parse(text);
    } catch {
      throw failure('GitLab вернул ответ не в формате JSON', 'protocol', { verify: mutation });
    }
  } finally {
    if (directory !== null) fs.rmSync(directory, { recursive: true, force: true });
  }
}

export function fetchMr(pin) {
  return gitlabRequest({ host: pin.host, endpoint: mrEndpoint(pin.project, pin.iid) });
}

export function fetchDiscussions(pin) {
  const discussions = [];
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const batch = gitlabRequest({
      host: pin.host,
      endpoint: mrEndpoint(pin.project, pin.iid, `/discussions?per_page=${PER_PAGE}&page=${page}`)
    });
    if (!Array.isArray(batch)) {
      throw new GantusError('GitLab вернул обсуждения не в ожидаемом формате', 'protocol');
    }
    discussions.push(...batch);
    if (batch.length < PER_PAGE) return discussions;
  }
  throw new GantusError('обсуждения MR не помещаются в проверяемый предел страниц', 'protocol');
}

export function requestMerge(pin, json) {
  return gitlabRequest({
    host: pin.host,
    method: 'PUT',
    endpoint: mrEndpoint(pin.project, pin.iid, '/merge'),
    json,
    mutation: true
  });
}

export function assertUnresolvedDiscussions(discussions) {
  for (const discussion of discussions) {
    if (!discussion || typeof discussion !== 'object' || !Array.isArray(discussion.notes)
        || discussion.notes.length === 0) {
      throw new GantusError('GitLab вернул обсуждение без списка заметок', 'protocol');
    }
    for (const note of discussion.notes) {
      if (!note || typeof note.resolvable !== 'boolean') {
        throw new GantusError('GitLab вернул заметку без признака resolvable', 'protocol');
      }
      if (note.resolvable && note.resolved !== true) {
        throw new GantusError('в MR есть неразрешённое обсуждение; merge отменён', 'conflict');
      }
    }
  }
}

export function sha(value) {
  return typeof value === 'string' && SHA40.test(value) ? value.toLowerCase() : null;
}
