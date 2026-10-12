// Черновики агента в /tmp. core.md разрешает `> /tmp/x` для вывода команд, а
// удалять их никто не обязан: логи сборки, патчи частичного стейджинга,
// выводы ревью копились в /tmp неделями. Правило «убери за собой» в каждом
// скилле модель не держит, поэтому уборка — хук.
//
// Перед вызовом Bash или Write запоминаются пути в /tmp, которых ещё нет: всё,
// что появится по ним, создал агент. В конце хода (Stop в Claude Code, session.idle
// в OpenCode) — работа сдана, черновики больше не нужны — они удаляются; конец
// сессии (SessionEnd, session.deleted) убирает остаток прерванного хода. Чужие файлы в /tmp не трогаются:
// существовавший до вызова путь не записывается.
//
// Модуль чистый: не читает stdin, не пишет stdout.

import fs from 'node:fs';
import path from 'node:path';
import { statePath, repoRoot, TMP_DIRS } from './state-core.mjs';

// Каталог Claude Code (/tmp/claude-<uid>): выводы фоновых задач, им управляет он сам.
const OWN_DIR_RE = /^claude-\d+$/;
// Путь в /tmp внутри команды: до пробела, кавычки, разделителя или подстановки.
// Слово с `$`, `*`, `?`, `{` — не путь, а выражение: его значение хук не знает.
const PATH_RE = /(?:^|[\s=<>'"(|;&:])(\/[^\s'"`;|&<>()]+)/g;
// Расхождение часов файловой системы и Date.now(): ctime файла бывает округлён вниз.
const CLOCK_SLACK_MS = 2000;

function listFile(sid) {
  return /^[\w-]+$/.test(String(sid || '')) ? statePath(`scratch-${sid}.jsonl`) : null;
}

function inTmp(abs) {
  const top = TMP_DIRS.find((d) => abs.startsWith(d + path.sep));
  if (!top) return false;
  const first = abs.slice(top.length + 1).split(path.sep)[0];
  return Boolean(first) && !OWN_DIR_RE.test(first) && !repoRoot(path.dirname(abs));
}

export function scratchCandidates(toolName, toolInput) {
  if (toolName === 'Write') return [toolInput?.file_path].filter((p) => typeof p === 'string');
  if (toolName !== 'Bash') return [];
  return [...String(toolInput?.command || '').matchAll(PATH_RE)]
    .map((m) => m[1].replace(/\/+$/, ''))
    .filter((p) => !/[$*?{}[\]]/.test(p));
}

function exists(p) {
  try { fs.lstatSync(p); return true; } catch { return false; }
}

// Перед вызовом: несуществующие пути в /tmp — в список сессии.
export function recordScratch(sid, toolName, toolInput, now = Date.now()) {
  const file = listFile(sid);
  if (!file) return 0;
  const fresh = [...new Set(scratchCandidates(toolName, toolInput).map((p) => path.resolve(p)))]
    .filter((p) => inTmp(p) && !exists(p));
  if (!fresh.length) return 0;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, fresh.map((p) => JSON.stringify({ path: p, ts: now }) + '\n').join(''));
  return fresh.length;
}

// Конец хода или сессии: удалить созданное и сам список. Файл и ссылка — unlink, каталог —
// только пустой: содержимое, которого агент не называл, не наше. Путь, созданный
// раньше записи (ctime старше), за это время занял кто-то другой — остаётся.
export function removeScratch(sid) {
  const file = listFile(sid);
  if (!file) return 0;
  let lines;
  try { lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean); } catch { return 0; }
  const since = new Map();
  for (const line of lines) {
    try {
      const { path: p, ts } = JSON.parse(line);
      if (typeof p === 'string' && inTmp(p)) since.set(p, Math.min(since.get(p) ?? ts, ts));
    } catch { /* битая строка — пропускаем */ }
  }
  let removed = 0;
  // Глубже — раньше: файлы каталога уходят до попытки убрать сам каталог.
  for (const [p, ts] of [...since].sort((a, b) => b[0].length - a[0].length)) {
    try {
      const st = fs.lstatSync(p);
      if (st.ctimeMs < ts - CLOCK_SLACK_MS) continue;
      if (st.isDirectory()) fs.rmdirSync(p);
      else fs.unlinkSync(p);
      removed += 1;
    } catch { /* нет, не пуст или не наш — оставляем */ }
  }
  try { fs.unlinkSync(file); } catch { /* уже удалён */ }
  return removed;
}
