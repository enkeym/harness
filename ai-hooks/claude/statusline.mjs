#!/usr/bin/env node
// Claude Code, statusLine: каталог, ветка, название модели неоновым цветом
// тем-класса и индикатор ask mode.
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

// Неоновый цвет названия модели по её тем-классу. Оттенки подобраны так, чтобы не
// совпадать с LIME/AMBER/RED выше (те уже заняты ask mode и порогами контекста):
// здесь всё светлее и насыщеннее. Порядок по «весу» модели: бледно-салатовый →
// жёлтый → оранжевый → красный.
const MODEL_NEON = {
  weak: '\x1b[1;38;2;185;255;120m', // Haiku и прочее лёгкое — бледный неон-салат
  sonnet: '\x1b[1;38;2;255;229;41m', // неоновый жёлтый
  opus: '\x1b[1;38;2;255;138;20m', // неоновый оранжевый
  fable: '\x1b[1;38;2;255;41;61m', // неоновый красный
};

function modelBadge(model) {
  if (!model) return '';
  const m = model.toLowerCase();
  const color = m.includes('opus')
    ? MODEL_NEON.opus
    : m.includes('sonnet')
      ? MODEL_NEON.sonnet
      : m.includes('fable')
        ? MODEL_NEON.fable
        : MODEL_NEON.weak;
  return `${color}${model}${RESET}`;
}

function branch(dir) {
  const root = repoRoot(dir);
  return root ? headLabel(root) : '';
}

// Занятость контекстного окна. Пока её не видно, «сессия стала дорогой» заметно
// только по счёту в конце месяца; цвета — те же пороги, на которых срабатывает
// context-meter, чтобы предупреждение агенту и индикатор не расходились.
//
// Показываем токены, а не долю окна: с 1M-окном процент выглядит безобидно
// (220k — «22%»), тогда как платим мы ровно за эти токены на каждом ходе.
function contextBadge(transcriptPath) {
  const used = contextUsed(transcriptPath);
  if (!used) return '';
  const lvl = level(used.tokens);
  const color = lvl === 'hard' || lvl === 'hand' ? RED : lvl === 'soft' ? AMBER : DIM;
  const mark = lvl === 'hard' ? '!' : '';
  return `${color}ctx ${Math.round(used.tokens / 1000)}k${mark}${RESET}`;
}

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => { raw += c; });
process.stdin.on('end', () => {
  let input = {};
  try { input = JSON.parse(raw); } catch { /* нет ввода — покажем что есть */ }

  // Показываем текущий каталог, а режим спрашиваем про сессию — тот же
  // ключ, что у PreToolUse-гарда. Без session_id — корень сессии (см. anchorDir
  // в ask-core), а не каталог, куда агент ушёл `cd`.
  const dir = input.workspace?.current_dir || input.cwd || process.cwd();
  const anchor = input.workspace?.project_dir || dir;
  const short = dir.startsWith(HOME) ? `~${dir.slice(HOME.length)}` : dir;
  const parts = [short];

  const b = branch(dir);
  if (b) parts.push(b);

  // Модель выносим из общего DIM-блока: у неё своя неоновая точка-индикатор.
  const model = input.model?.display_name;

  // Режим показываем всегда: он включён по умолчанию, и «ничего не написано»
  // читалось бы как «правки разрешены».
  const mode = isOn(anchor, input.session_id) ? `${LIME}ask mode on${RESET}` : `${DIM}ask mode off${RESET}`;
  const line = [
    `${DIM}${parts.join('  ')}${RESET}`,
    modelBadge(model),
    contextBadge(input.transcript_path),
    mode,
  ]
    .filter(Boolean)
    .join('  ');

  process.stdout.write(line);
});
