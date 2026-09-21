// Карта неявных связей на диске — то, что читают и чекер (bin/check-impact-map.mjs),
// и хук подключения домена (claude/links-context.mjs): где каталог карты, какие
// файлы в нём домены, как из файла домена достать глобы `paths:`.
// Контракт формата: skills/shared/impact-map.md.

import fs from 'node:fs';
import path from 'node:path';

// Каталоги карты: свой репозиторий и общий (там карта не коммитится).
export const MAP_DIRS = ['docs/links', '.claude/links'];
export const INDEX_NAME = 'INDEX.md';

// Первый существующий каталог карты под корнем проекта; нет → null.
export function mapDirOf(root) {
  return MAP_DIRS.map((d) => path.join(root, d)).find((d) => fs.existsSync(d)) || null;
}

// Индексы, при которых карта нужна: есть чем собрать кандидатов (seed) и есть
// кому её подключать. Без индекса impact идёт через grep, карты нет.
const INDEX_DBS = [path.join('.tokensave', 'tokensave.db'), path.join('.ragsave', 'rag.db')];

export function hasIndex(root) {
  return INDEX_DBS.some((db) => fs.existsSync(path.join(root, db)));
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

// Frontmatter файла домена в формате .claude/rules: `paths:` и список глобов.
// Нет frontmatter или нет `paths:` → null: файл достижим только через индекс.
// Пустой список — отдельный случай, чекер о нём сообщает.
export function pathsOf(text) {
  const m = text.match(/^---\n([\s\S]*?)\n---\n/);
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

// Тело файла домена без frontmatter — то, что стоит показывать модели.
export function bodyOf(text) {
  return text.replace(/^---\n[\s\S]*?\n---\n\s*/, '');
}
