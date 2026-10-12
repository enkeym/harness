#!/usr/bin/env node
// Первая карта неявных связей в проекте с индексом tokensave или ragsave
// (кандидатов без графа seed собирает через git grep): скелет docs/links/INDEX.md.
// Связи в неё пишет скилл impact-map — скрипт знает только, нужна ли карта
// вообще и есть ли она уже.
//
// Использование: init-impact-map.mjs [cwd] — проект берётся от cwd (git-корень).
// Код 0 — карта есть или создана, либо не нужна; 1 — плоская карта, разбить руками.

import fs from 'node:fs';
import path from 'node:path';
import { repoRootOr } from '../state-core.mjs';
import { projectRoot } from '../guard-core.mjs';
import { hasIndex, MAP_DIR, INDEX_NAME } from '../links-core.mjs';

const LEGACY = ['docs/implicit-links.md', '.claude/implicit-links.md'];

const INDEX_SKELETON = `# Карта скрытых связей — индекс

Связи, которые компилятор и тесты не ловят: «тронул X → обнови Y, потому что Z».
Файл домена подключает хук по его \`paths:\`, когда правка попала в эти пути;
перед коммитом (impact-проход) открывай его по индексу. Формат строки:
\`- <домен> — <файл>.md — <одна фраза>\`, проверка ссылок и глобов:
\`node ~/.ai-hooks/bin/check-impact-map.mjs\`.
`;

const root = repoRootOr(process.argv[2] || process.cwd());
const say = (line) => process.stdout.write(`${line}\n`);

if (!projectRoot(root) && !hasIndex(root)) {
  say(`карта: в ${root} нет индекса tokensave или ragsave — impact через grep, карта не нужна`);
  process.exit(0);
}

if (fs.existsSync(path.join(root, MAP_DIR))) {
  say(`карта: ${MAP_DIR} — уже есть`);
  process.exit(0);
}

const legacy = LEGACY.find((f) => fs.existsSync(path.join(root, f)));
if (legacy) {
  say(`карта: ${legacy} — плоская, разбить на INDEX.md и файлы сущностей`);
  process.exit(1);
}

const indexFile = path.join(root, MAP_DIR, INDEX_NAME);
fs.mkdirSync(path.dirname(indexFile), { recursive: true });
fs.writeFileSync(indexFile, INDEX_SKELETON);
say(`карта: создана ${MAP_DIR}/${INDEX_NAME}`);
