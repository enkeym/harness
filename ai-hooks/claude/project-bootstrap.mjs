#!/usr/bin/env node
// Claude Code, SessionStart (startup|clear): чего не хватает проекту.
//
// Смотрит корень git-репозитория текущего каталога и кладёт в контекст список
// пропусков: нет CLAUDE.md, нет husky, нет CI для GitHub-remote, нет
// карты неявных связей в проекте с индексом tokensave/ragsave.
// Что с этим делать — решает скилл hooks-guards, о пропусках хук только сообщает.
// Молчит вне репозитория, в $HOME и в конфигах агентов. Про CI, husky и карту
// напоминает не чаще раза в неделю на проект (иначе подсказка станет фоном);
// про CLAUDE.md и карту в первую сессию с индексом (момент инициализации
// tokensave/ragsave) — одним пунктом, метка постоянная.
//
// Ещё хук достраивает индекс: есть ровно один из двух — init прошёл мимо
// обёртки shell или прогон bin/project-init.sh оборвался, — и тот же скрипт
// уходит в фон за вторым.
//
// Отсутствие бывает осознанным: проект может не хотеть CLAUDE.md или husky.
// Тогда `.claude/bootstrap-ignore` в корне перечисляет по строке на пункт
// (`husky`, `ci`, `dependabot`, `impact-map`), и о них хук молчит. Без этого
// недельное напоминание про намеренно отсутствующее превращается в шум.
// CLAUDE.md в список не входит: он и так выдаётся один раз.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync, spawn } from 'node:child_process';
import { isHarnessConfigPath } from '../guard-core.mjs';
import { hasIndex, mapDirOf } from '../links-core.mjs';
import { statePath, projectKey, isEntryPoint } from '../state-core.mjs';

const HOME = process.env.HOME || os.homedir();
const STATE_DIR = statePath('bootstrap');
const REMIND_MS = 7 * 24 * 3600 * 1000;
// Переменная — подмена в тестах.
const PROJECT_INIT_CMD = process.env.AI_HOOKS_PROJECT_INIT_CMD || path.join(HOME, '.ai-hooks', 'bin', 'project-init.sh');

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

// Постоянная метка: пункт выдаётся один раз на проект, без срока давности.
function firstTime(root, kind) {
  const file = path.join(STATE_DIR, `${kind}-${projectKey(root)}`);
  if (fs.existsSync(file)) return false;
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.writeFileSync(file, new Date().toISOString());
  } catch { /* без метки напомним ещё раз — не страшно */ }
  return true;
}

// Корень проекта, о котором хук говорит; null — молчать.
function projectRoot(cwd) {
  const start = path.resolve(cwd || process.cwd());
  if (start === HOME || isHarnessConfigPath(start)) return null;
  const root = gitRoot(start);
  return root && root !== HOME ? root : null;
}

// Ровно один индекс → project-init.sh в фоне строит второй. Только tokensave
// при .ragsave-disable — так и задумано.
function completeIndex(root) {
  const tokensave = exists(root, '.tokensave', 'tokensave.db');
  const ragsave = exists(root, '.ragsave', 'rag.db');
  if (tokensave === ragsave || (tokensave && exists(root, '.ragsave-disable'))) return;
  try {
    fs.accessSync(PROJECT_INIT_CMD, fs.constants.X_OK);
  } catch {
    return;  // харнесс не установлен — второй индекс за ручным init
  }
  spawn(PROJECT_INIT_CMD, ['--detach', root], { detached: true, stdio: 'ignore' }).unref();
}

export function bootstrapContext(root) {
  const isNode = exists(root, 'package.json');
  const ignored = ignoredItems(root);
  const always = [];
  const weekly = [];

  const indexed = hasIndex(root);
  const noClaudeMd = !exists(root, 'CLAUDE.md');
  const noMap = indexed && !ignored.has('impact-map') && !mapDirOf(root);
  // Первая сессия с индексом: оба пропуска одним пунктом, недельный пункт
  // карты в неё не входит, а его неделя отсчитывается отсюда.
  const initSession = indexed && (noClaudeMd || noMap) && firstTime(root, 'init');
  if (initSession) {
    const gaps = [noClaudeMd && 'no project CLAUDE.md', noMap && 'no map of implicit links (/impact-map)'].filter(Boolean);
    always.push(`project just indexed: ${gaps.join(', ')}`);
  }

  if (isNode) {
    if (!ignored.has('husky') && !exists(root, '.husky')) weekly.push('no husky (pre-commit: lint-staged + tsc)');
    const remote = remoteUrl(root);
    if (!ignored.has('ci') && /github\.com/.test(remote) && !exists(root, '.github', 'workflows')) weekly.push('GitHub remote without .github/workflows (CI)');
    if (!ignored.has('dependabot') && /github\.com/.test(remote) && !exists(root, '.github', 'dependabot.yml')) weekly.push('no .github/dependabot.yml');
    if (!ignored.has('ci') && /gitlab/.test(remote) && !exists(root, '.gitlab-ci.yml')) weekly.push('GitLab remote without .gitlab-ci.yml');
  }
  if (noMap && !initSession) weekly.push('index present, no map of implicit links (/impact-map)');

  const items = [...always];
  if ((weekly.length || initSession) && !remindedRecently(root)) items.push(...weekly);
  if (items.length === 0) return null;

  return `project-bootstrap (${path.basename(root)}): ${items.join('; ')}. ` +
    'Offer it in one line in your first reply (skill hooks-guards).';
}

if (isEntryPoint(import.meta.url)) {
  let raw = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (c) => { raw += c; });
  process.stdin.on('end', () => {
    try {
      const input = JSON.parse(raw);
      const root = projectRoot(input.cwd);
      if (root) completeIndex(root);
      const context = root && bootstrapContext(root);
      if (context) {
        process.stdout.write(JSON.stringify({
          hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: context },
        }));
      }
    } catch { /* подсказка не должна ломать старт */ }
    process.exit(0);
  });
}
