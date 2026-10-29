// Корень проекта для инструментов карты связей.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const HOME = process.env.HOME || os.homedir();
// Временный каталог не является корнем дочернего проекта.
const TMP_DIRS = [...new Set(['/tmp', os.tmpdir()].flatMap((d) => {
  try { return [path.resolve(d), fs.realpathSync(d)]; } catch { return [path.resolve(d)]; }
}))];

function hasGit(dir) {
  return fs.existsSync(path.join(dir, '.git'));
}

// Ближайший каталог вверх по дереву с `.git`. $HOME не считается репозиторием
// (даже если он под git — так у всех прежних реализаций) и выше $HOME не идём.
// Нет репозитория → null.
export function repoRoot(cwd) {
  let dir = path.resolve(cwd || process.cwd());
  while (dir && dir !== HOME) {
    // Общий временный каталог не является проектом дочерних песочниц.
    if (TMP_DIRS.includes(dir)) return null;
    if (hasGit(dir)) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

// Вне репозитория инструменты карты работают в указанном каталоге.
export function repoRootOr(cwd) {
  return repoRoot(cwd) || path.resolve(cwd || process.cwd());
}
