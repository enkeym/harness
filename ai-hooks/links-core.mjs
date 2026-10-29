// Карта неявных связей на диске — то, что читают и чекер (bin/check-impact-map.mjs),
// файлы в нём домены, как из файла домена достать глобы `paths:`.
// Контракт формата: skills/shared/impact-map.md.

import fs from 'node:fs';
import path from 'node:path';

// Каталог карты — рядом с остальными доками проекта. Команда против коммита
// карты → каталог уходит в .git/info/exclude, путь тот же.
export const MAP_DIR = 'docs/links';
export const INDEX_NAME = 'INDEX.md';

// Каталог карты под корнем проекта; нет → null.
export function mapDirOf(root) {
  const dir = path.join(root, MAP_DIR);
  return fs.existsSync(dir) ? dir : null;
}

// Индексы ровно в корне проекта, без поиска вверх: индекс родительского
// каталога — чужой граф. dirty — метка оборванного init tokensave (её же смотрит
// bin/project-init.sh:need_ts), ragsaveOff — проект отказался от ragsave.
export function indexesOf(root) {
  const has = (...p) => fs.existsSync(path.join(root, ...p));
  return {
    tokensave: has('.tokensave', 'tokensave.db'),
    ragsave: has('.ragsave', 'rag.db'),
    dirty: has('.tokensave', 'dirty'),
    ragsaveOff: has('.ragsave-disable'),
  };
}

// Индекс для сбора кандидатов карты. Без индекса impact идёт через rg.
export function hasIndex(root) {
  const { tokensave, ragsave } = indexesOf(root);
  return tokensave || ragsave;
}

// Файлы доменов относительно каталога карты со слэшами вперёд: `tracking.md`
// или `tracking/rls.md`, когда домен разбит на каталог. Индекс — не домен.
export function domainFiles(mapDir) {
  return fs
    .readdirSync(mapDir, { recursive: true })
    .map((n) => n.split(path.sep).join('/'))
    .filter((n) => n.endsWith('.md') && n !== INDEX_NAME)
    .sort();
}

// Нет frontmatter или нет `paths:` → null: файл достижим только через индекс.
// Пустой список — отдельный случай, чекер о нём сообщает.
// CRLF (файл правили из Windows-редактора) приводится к LF, иначе frontmatter
// не распознаётся и домен молча не подключается.
const lf = (text) => text.replace(/\r\n/g, '\n');

export function pathsOf(text) {
  const m = lf(text).match(/^---\n([\s\S]*?)\n---\n/);
  if (!m) return null;
  const lines = m[1].split('\n');
  const start = lines.findIndex((l) => /^paths:\s*$/.test(l));
  if (start < 0) return null;
  const globs = [];
  for (const line of lines.slice(start + 1)) {
    const item = line.match(/^\s+-\s+["']?([^"'#]+?)["']?\s*$/);
    if (!item) break;
    globs.push(item[1]);
  }
  return globs;
}
