#!/usr/bin/env node
// Claude Code, statusLine: каталог, ветка, модель и индикатор ask mode.
// Встроенная строка режимов (manual/accept edits/plan/auto) рисуется самим CLI
// и про ask mode ничего не знает — поэтому индикатор живёт здесь.

import os from 'node:os';
import { isOn } from '../ask-core.mjs';
import { repoRoot, headLabel } from '../state-core.mjs';

const HOME = process.env.HOME || os.homedir();

const DIM = '\x1b[2m';
const RESET = '\x1b[0m';
const LIME = '\x1b[1;38;2;154;230;0m'; // салатовый

function branch(dir) {
  const root = repoRoot(dir);
  return root ? headLabel(root) : '';
}

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => { raw += c; });
process.stdin.on('end', () => {
  let input = {};
  try { input = JSON.parse(raw); } catch { /* нет ввода — покажем что есть */ }

  const dir = input.workspace?.current_dir || input.cwd || process.cwd();
  const short = dir.startsWith(HOME) ? `~${dir.slice(HOME.length)}` : dir;
  const parts = [short];

  const b = branch(dir);
  if (b) parts.push(b);

  const model = input.model?.display_name;
  if (model) parts.push(model);

  // Режим показываем всегда: он включён по умолчанию, и «ничего не написано»
  // читалось бы как «правки разрешены».
  const line = `${DIM}${parts.join('  ')}${RESET}  ` +
    (isOn(dir) ? `${LIME}ask mode on${RESET}` : `${DIM}ask mode off${RESET}`);

  process.stdout.write(line);
});
