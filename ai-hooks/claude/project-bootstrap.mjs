#!/usr/bin/env node
// Claude Code, SessionStart (startup|clear): чего не хватает проекту.
//
// Смотрит корень git-репозитория текущего каталога и кладёт в контекст список
// пропусков: нет CLAUDE.md, нет husky, нет CI для GitHub-remote, нет
// примера env при наличии .env, нет карты неявных связей в проекте с индексом
// tokensave/ragsave. Пример env ищется по маске `.env*.example`
// (`.env.dev.example` тоже считается) и отдельно в каждом каталоге со своим
// package.json — иначе монорепо ругается на пропуск, которого нет.
// Что с этим делать — решает скилл hooks-guards, хук только сообщает факты.
// Молчит вне репозитория, в $HOME и в конфигах агентов. Про CI, husky и карту
// напоминает не чаще раза в неделю на проект (иначе подсказка станет фоном);
// про CLAUDE.md — каждый раз, пока файла нет.
//
// Отсутствие бывает осознанным: проект может не хотеть CLAUDE.md или husky.
// Тогда `.claude/bootstrap-ignore` в корне перечисляет по строке на пункт
// (`claude-md`, `husky`, `ci`, `dependabot`, `env-example`, `impact-map`),
// и о них хук молчит. Без этого напоминание про намеренно удалённый файл
// превращается в постоянный шум, ради устранения которого хук и писался.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { isHarnessConfigPath } from '../guard-core.mjs';
import { hasIndex, mapDirOf } from '../links-core.mjs';
import { statePath, projectKey, isEntryPoint } from '../state-core.mjs';

const HOME = process.env.HOME || os.homedir();
const STATE_DIR = statePath('bootstrap');
const REMIND_MS = 7 * 24 * 3600 * 1000;

function gitRoot(cwd) {
  try {
    return execFileSync('git', ['-C', cwd, 'rev-parse', '--show-toplevel'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return null;
  }
}

function remoteUrl(root) {
  try {
    return execFileSync('git', ['-C', root, 'remote', 'get-url', 'origin'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return '';
  }
}

const exists = (...p) => fs.existsSync(path.join(...p));

const ENV_EXAMPLE = /^\.env.*\.example$/;
const ENV_FILE = /^\.env(\..+)?$/;

// Не workspaces: каталоги с собственным package.json держат свои .env.
function envDirs(root) {
  const dirs = [root];
  let entries = [];
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return dirs; }
  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith('.') || e.name === 'node_modules') continue;
    if (exists(root, e.name, 'package.json')) dirs.push(path.join(root, e.name));
  }
  return dirs;
}

function envGaps(root) {
  const gaps = [];
  for (const dir of envDirs(root)) {
    let names = [];
    try { names = fs.readdirSync(dir); } catch { continue; }
    const hasEnv = names.some((n) => ENV_FILE.test(n) && !ENV_EXAMPLE.test(n));
    if (!hasEnv || names.some((n) => ENV_EXAMPLE.test(n))) continue;
    gaps.push(dir === root ? '.' : path.relative(root, dir));
  }
  return gaps;
}

// Пункты, которые проект объявил осознанно ненужными.
function ignoredItems(root) {
  let raw = '';
  try { raw = fs.readFileSync(path.join(root, '.claude', 'bootstrap-ignore'), 'utf8'); } catch { return new Set(); }
  return new Set(
    raw.split('\n')
      .map((line) => line.replace(/#.*$/, '').trim().toLowerCase())
      .filter(Boolean),
  );
}

function remindedRecently(root) {
  const file = path.join(STATE_DIR, projectKey(root));
  try {
    if (Date.now() - fs.statSync(file).mtimeMs < REMIND_MS) return true;
  } catch { /* первое напоминание */ }
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.writeFileSync(file, new Date().toISOString());
  } catch { /* без метки напомним ещё раз — не страшно */ }
  return false;
}

export function bootstrapContext(cwd) {
  const start = path.resolve(cwd || process.cwd());
  if (start === HOME || isHarnessConfigPath(start)) return null;
  const root = gitRoot(start);
  if (!root || root === HOME) return null;

  const isNode = exists(root, 'package.json');
  const ignored = ignoredItems(root);
  const always = [];
  const weekly = [];

  if (!ignored.has('claude-md') && !exists(root, 'CLAUDE.md')) always.push('нет CLAUDE.md проекта');
  if (!ignored.has('env-example')) {
    const gaps = envGaps(root);
    if (gaps.length) always.push(`есть .env без .env.example (${gaps.join(', ')})`);
  }

  if (isNode) {
    if (!ignored.has('husky') && !exists(root, '.husky')) weekly.push('нет husky (pre-commit: lint-staged + tsc)');
    const remote = remoteUrl(root);
    if (!ignored.has('ci') && /github\.com/.test(remote) && !exists(root, '.github', 'workflows')) weekly.push('GitHub-remote без .github/workflows (CI)');
    if (!ignored.has('dependabot') && /github\.com/.test(remote) && !exists(root, '.github', 'dependabot.yml')) weekly.push('нет .github/dependabot.yml');
    if (!ignored.has('ci') && /gitlab/.test(remote) && !exists(root, '.gitlab-ci.yml')) weekly.push('GitLab-remote без .gitlab-ci.yml');
  }
  if (!ignored.has('impact-map') && hasIndex(root) && !mapDirOf(root)) weekly.push('есть индекс, но нет карты неявных связей (/impact-map)');

  const items = [...always];
  if (weekly.length && !remindedRecently(root)) items.push(...weekly);
  if (items.length === 0) return null;

  return `project-bootstrap (${path.basename(root)}): ${items.join('; ')}. ` +
    'Предложи одной строкой в первом ответе (скилл hooks-guards).';
}

if (isEntryPoint(import.meta.url)) {
  let raw = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (c) => { raw += c; });
  process.stdin.on('end', () => {
    try {
      const input = JSON.parse(raw);
      const context = bootstrapContext(input.cwd);
      if (context) {
        process.stdout.write(JSON.stringify({
          hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: context },
        }));
      }
    } catch { /* подсказка не должна ломать старт */ }
    process.exit(0);
  });
}
