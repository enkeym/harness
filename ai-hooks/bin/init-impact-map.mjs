#!/usr/bin/env node
// Первая карта неявных связей в проекте с индексом tokensave или ragsave
// (кандидатов без графа seed собирает через git grep): скелет INDEX.md там, где
// карте место по авторству репозитория. Связи в неё пишет скилл impact-map —
// скрипт знает только, нужна ли карта вообще и где она лежит.
//
// Использование: init-impact-map.mjs [cwd] — проект берётся от cwd (git-корень).
// Код 0 — карта есть или создана, либо не нужна; 1 — плоская карта, разбить руками.

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { repoRootOr } from '../state-core.mjs';
import { projectRoot } from '../guard-core.mjs';
import { hasIndex } from '../links-core.mjs';

const OWN_DIR = 'docs/links';
const SHARED_DIR = '.claude/links';
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

function git(args) {
  try {
    return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return '';
  }
}

// Свой репозиторий — каждый коммит от текущего user.email. Пустая история —
// тоже свой: чужого автора в ней нет. Нет user.email — решить нельзя, карта
// идёт в игнорируемый каталог, чтобы не попасть в чужую историю по догадке.
function isOwnRepository() {
  const me = git(['config', 'user.email']);
  if (!me) return false;
  const authors = git(['log', '--format=%ae']).split('\n').filter(Boolean);
  return authors.every((a) => a === me);
}

if (!projectRoot(root) && !hasIndex(root)) {
  say(`карта: в ${root} нет индекса tokensave или ragsave — impact через grep, карта не нужна`);
  process.exit(0);
}

const existing = [OWN_DIR, SHARED_DIR].find((d) => fs.existsSync(path.join(root, d)));
if (existing) {
  say(`карта: ${existing} — уже есть`);
  process.exit(0);
}

const legacy = LEGACY.find((f) => fs.existsSync(path.join(root, f)));
if (legacy) {
  say(`карта: ${legacy} — плоская, разбить на INDEX.md и файлы сущностей`);
  process.exit(1);
}

const mapDir = isOwnRepository() ? OWN_DIR : SHARED_DIR;
const indexFile = path.join(root, mapDir, 'INDEX.md');
fs.mkdirSync(path.dirname(indexFile), { recursive: true });
fs.writeFileSync(indexFile, INDEX_SKELETON);
say(`карта: создана ${mapDir}/INDEX.md`);
