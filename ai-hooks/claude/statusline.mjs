#!/usr/bin/env node
// Claude Code, statusLine: каталог, ветка, модель и индикатор ask mode.
// Встроенная строка режимов (manual/accept edits/plan/auto) рисуется самим CLI
// и про ask mode ничего не знает — поэтому индикатор живёт здесь.

import os from 'node:os';
import { isOn } from '../ask-core.mjs';
import { repoRoot, headLabel } from '../state-core.mjs';
import { contextUsed, level } from '../context-core.mjs';

const HOME = process.env.HOME || os.homedir();

const DIM = '\x1b[2m';
const RESET = '\x1b[0m';
const LIME = '\x1b[1;38;2;154;230;0m'; // салатовый
const AMBER = '\x1b[1;38;2;230;180;0m';
const RED = '\x1b[1;38;2;230;80;60m';

function branch(dir) {
  const root = repoRoot(dir);
  return root ? headLabel(root) : '';
}

// Занятость контекстного окна. Пока её не видно, «сессия стала дорогой» заметно
// только по счёту в конце месяца; цвета — те же пороги, на которых срабатывает
// context-meter, чтобы предупреждение агенту и индикатор не расходились.
function contextBadge(transcriptPath) {
  const used = contextUsed(transcriptPath);
  if (!used) return '';
  const lvl = level(used.pct);
  const color = lvl === 'act' ? RED : lvl === 'warn' ? AMBER : DIM;
  return `${color}ctx ${used.pct}%${RESET}`;
}

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => { raw += c; });
process.stdin.on('end', () => {
  let input = {};
  try { input = JSON.parse(raw); } catch { /* нет ввода — покажем что есть */ }

  // Показываем текущий каталог, но режим спрашиваем про корень сессии — тот же
  // якорь, что у PreToolUse-гарда (см. anchorDir в ask-core). Иначе индикатор
  // и запреты расходятся, стоит агенту уйти `cd` в соседний репозиторий.
  const dir = input.workspace?.current_dir || input.cwd || process.cwd();
  const anchor = input.workspace?.project_dir || dir;
  const short = dir.startsWith(HOME) ? `~${dir.slice(HOME.length)}` : dir;
  const parts = [short];

  const b = branch(dir);
  if (b) parts.push(b);

  const model = input.model?.display_name;
  if (model) parts.push(model);

  // Режим показываем всегда: он включён по умолчанию, и «ничего не написано»
  // читалось бы как «правки разрешены».
  const mode = isOn(anchor) ? `${LIME}ask mode on${RESET}` : `${DIM}ask mode off${RESET}`;
  const line = [`${DIM}${parts.join('  ')}${RESET}`, contextBadge(input.transcript_path), mode]
    .filter(Boolean)
    .join('  ');

  process.stdout.write(line);
});
