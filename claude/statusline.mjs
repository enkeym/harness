#!/usr/bin/env node
// Claude Code, statusLine: каталог, ветка, модель и индикатор ask mode.
// Встроенная строка режимов (manual/accept edits/plan/auto) рисуется самим CLI
// и про ask mode ничего не знает — поэтому индикатор живёт здесь.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { isOn } from '../ask-core.mjs';

const HOME = process.env.HOME || os.homedir();

const DIM = '\x1b[2m';
const RESET = '\x1b[0m';
const LIME = '\x1b[1;38;2;154;230;0m'; // салатовый

function branch(dir) {
  try {
    let gitDir = path.join(dir, '.git');
    if (fs.statSync(gitDir).isFile()) {
      const m = fs.readFileSync(gitDir, 'utf8').match(/gitdir:\s*(.+)/);
      gitDir = m ? path.resolve(dir, m[1].trim()) : gitDir;
    }
    const head = fs.readFileSync(path.join(gitDir, 'HEAD'), 'utf8').trim();
    const ref = head.match(/^ref:\s*refs\/heads\/(.+)$/);
    return ref ? ref[1] : head.slice(0, 7);
  } catch {
    const parent = path.dirname(dir);
    return parent === dir ? '' : branch(parent);
  }
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
