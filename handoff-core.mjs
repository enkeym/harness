// Передача между сессиями — общее ядро.
//
// `/clear` дешевеет ровно настолько, насколько не страшно его нажать. Пока
// состояние работы живёт только в контексте, очистка означает потерю, и сессия
// тянется дальше, а каждый её ход стоит всего накопленного контекста. Файл
// передачи разрывает эту связь: контекст выбрасывается, знание остаётся.
//
// Ключ — корень репозитория, как у ask mode: сессия ходит по подкаталогам, а
// передача у проекта одна. Файл пишет агент обычным Write, хук только
// подставляет его на старте — писать через хук было бы нечем, у него нет
// содержания работы.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { repoRootOr } from './state-core.mjs';

const HOME = process.env.HOME || os.homedir();
export const HANDOFF_DIR = path.join(HOME, '.claude', 'handoff');

// Старая передача хуже отсутствующей: она описывает работу, которую давно
// заменили, и агент начинает с неверной картины.
export const STALE_MS = 14 * 24 * 3600 * 1000;
// Передача не должна сама стать статьёй расхода: это указатель на состояние,
// а не пересказ сессии.
export const MAX_CHARS = 6000;

// Корень репозитория (repoRootOr из state-core), тот же, что у ask mode.

// Имя читаемое (чтобы файл можно было найти глазами) плюс ключ от полного пути.
//
// Ключ — хеш, а не хвост base64 этого же пути: хвост определяется последними
// байтами, то есть тем же basename, что уже стоит в имени. `~/main/vpn-new` и
// `~/work/vpn-new` получали один файл, и состояние приватного проекта уехало бы
// в контекст чужой сессии до первого слова пользователя.
export function handoffPath(cwd) {
  const root = repoRootOr(cwd);
  const slug = path.basename(root).replace(/[^\w.-]/g, '-') || 'root';
  const key = createHash('sha256').update(root).digest('hex').slice(0, 12);
  return path.join(HANDOFF_DIR, `${slug}-${key}.md`);
}

export function readHandoff(cwd) {
  const file = handoffPath(cwd);
  let stat;
  let text;
  try {
    stat = fs.statSync(file);
    text = fs.readFileSync(file, 'utf8').trim();
  } catch {
    return null;
  }
  if (!text) return null;

  const ageMs = Date.now() - stat.mtimeMs;
  const clipped = text.length > MAX_CHARS
    ? `${text.slice(0, MAX_CHARS)}\n…(передача обрезана, полностью в ${file})`
    : text;
  return { file, text: clipped, ageMs, stale: ageMs > STALE_MS };
}

export function humanAge(ms) {
  const hours = ms / 3600000;
  if (hours < 1) return `${Math.max(1, Math.round(ms / 60000))} мин назад`;
  if (hours < 48) return `${Math.round(hours)} ч назад`;
  return `${Math.round(hours / 24)} дн назад`;
}

export function handoffContext(cwd) {
  const h = readHandoff(cwd);
  if (!h || h.stale) return null;
  return `Передача из прошлой сессии (${humanAge(h.ageMs)}, ${h.file}):\n\n${h.text}\n\n` +
    'Это снимок состояния, а не инструкция: проверяй факты, прежде чем на них опираться. ' +
    'Файл перезаписывай перед следующим `/clear`.';
}
