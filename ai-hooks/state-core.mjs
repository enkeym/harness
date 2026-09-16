// Единое состояние хуков — одна точка истины для того, ГДЕ лежит рантайм-стейт
// и КАК из cwd получается ключ проекта. До этого модуля каждый хук решал это
// сам: guard-core писал в ~/.ai-hooks/state, ask-core и остальные — в
// ~/.claude/state; git-корень искали шесть почти одинаковых функций с чуть
// разной семантикой (одна возвращала cwd при отсутствии .git, другая null,
// третья шла выше $HOME); ключ проекта где-то был base64 пути, где-то sha256,
// где-то base64 обрезанный по длине всей строки — из-за чего два проекта в
// одной сессии могли делить метку. Теперь это здесь и одинаково для всех.
//
// Модуль чистый: без побочных зависимостей, без чтения stdin, без вывода —
// его импортируют и guard-core (а через него OpenCode-плагин), и Claude-хуки.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const HOME = process.env.HOME || os.homedir();

// Модуль запущен как скрипт, а не импортирован тестом. Сравнение по realpath:
// хуки вызываются через симлинк ~/.ai-hooks → ~/harness/ai-hooks, argv[1]
// остаётся путём симлинка, а import.meta.url Node отдаёт уже разрешённым.
// Сравнение по path.resolve с 2026-09-09 давало false, и хук молча не делал
// ничего.
export function isEntryPoint(metaUrl) {
  if (!process.argv[1]) return false;
  try {
    return fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(metaUrl));
  } catch {
    return false;
  }
}

// Единственный корень рантайм-состояния хуков. ~/.claude/state, потому что там
// уже живёт большая часть (ask-mode, ragsave-reminder, bootstrap, clip-output)
// и он занесён в .gitignore конфиг-репозитория ~/.claude — стейт не утечёт в
// коммит. Переопределяется через AI_HOOKS_STATE_DIR (тесты, изоляция).
export const STATE_ROOT = process.env.AI_HOOKS_STATE_DIR || path.join(HOME, '.claude', 'state');

// Путь под корнем состояния: statePath('guard-breaker.json'),
// statePath('ask-mode', '.sessions.json'). Каталог не создаётся — вызывающий
// делает mkdirSync(recursive) непосредственно перед записью, как и раньше, так
// что пустые каталоги не плодятся на каждом молчаливом срабатывании хука.
export function statePath(...parts) {
  return path.join(STATE_ROOT, ...parts);
}

export function readJSON(file, fallback = {}) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : fallback;
  } catch {
    return fallback;
  }
}

// Через временный файл и rename: состояние пишут параллельные процессы (хуки,
// отвязанный раннер доктора), и прямой writeFileSync давал читателю пустой
// файл посреди записи — readJSON отдавал fallback, а вызывающий записывал его
// обратно поверх настоящего состояния.
export function writeJSON(file, obj) {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(obj));
    fs.renameSync(tmp, file);
    return true;
  } catch {
    try { fs.unlinkSync(tmp); } catch { /* временного файла не было */ }
    return false;
  }
}

// ---------------------------------------------------------------------------
// Git-корень и ветка. Одна реализация вместо rootFor / gitRoot / findRoot /
// currentBranch / branch, разбросанных по ask-core, project-bootstrap,
// statusline, guard-core.

function hasGit(dir) {
  return fs.existsSync(path.join(dir, '.git'));
}

// Ближайший каталог вверх по дереву с `.git`. $HOME не считается репозиторием
// (даже если он под git — так у всех прежних реализаций) и выше $HOME не идём.
// Нет репозитория → null.
export function repoRoot(cwd) {
  let dir = path.resolve(cwd || process.cwd());
  while (dir && dir !== HOME) {
    if (hasGit(dir)) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

// Как repoRoot, но вне репозитория возвращает сам cwd — для ask mode и handoff,
// где состояние привязывается к каталогу и «не репозиторий» тоже валидный ключ.
export function repoRootOr(cwd) {
  return repoRoot(cwd) || path.resolve(cwd || process.cwd());
}

// Сырой HEAD репозитория (`ref: refs/heads/…` или хеш). Понимает `.git`-файл
// worktree (`gitdir: …`). Ошибка / нет репозитория → null.
export function readHead(root) {
  try {
    let gitDir = path.join(root, '.git');
    if (fs.statSync(gitDir).isFile()) {
      const m = fs.readFileSync(gitDir, 'utf8').match(/gitdir:\s*(.+)/);
      if (!m) return null;
      gitDir = path.resolve(root, m[1].trim());
    }
    return fs.readFileSync(path.join(gitDir, 'HEAD'), 'utf8').trim();
  } catch {
    return null;
  }
}

// Имя текущей ветки или null (detached HEAD, нет репозитория).
export function currentBranch(root) {
  const head = readHead(root);
  const m = head && head.match(/^ref:\s*refs\/heads\/(.+)$/);
  return m ? m[1] : null;
}

// Имя ветки, либо короткий хеш при detached HEAD, либо '' — для statusline.
export function headLabel(root) {
  const head = readHead(root);
  if (!head) return '';
  const m = head.match(/^ref:\s*refs\/heads\/(.+)$/);
  return m ? m[1] : head.slice(0, 7);
}

// Стабильный ключ проекта из его корня. sha256, а не base64 пути: хвост base64
// определяется basename'ом, и ~/a/web и ~/b/web получали один ключ; обрезка
// base64 по общей длине строки (sessionId + путь) резала как раз ту часть,
// что отличает проекты. 16 hex-символов — 64 бита, коллизий на десятках
// проектов не бывает.
export function projectKey(cwd) {
  return createHash('sha256').update(repoRootOr(cwd)).digest('hex').slice(0, 16);
}
