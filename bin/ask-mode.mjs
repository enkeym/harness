#!/usr/bin/env node
// Переключатель ask mode.
//
//   ask-mode.mjs on | off | toggle        — режим для текущего каталога
//   ask-mode.mjs reset                    — вернуть каталог к режиму по умолчанию
//   ask-mode.mjs default [on|off]         — режим по умолчанию (все новые сессии)
//   ask-mode.mjs status                   — что сейчас и откуда взято
//
// Каталог: --dir <путь>, иначе текущий.

import { state, isOn, setMode, resetMode, defaultOn, setDefault } from '../ask-core.mjs';

const args = process.argv.slice(2);
const dirFlag = args.indexOf('--dir');
const dir = dirFlag !== -1 ? args[dirFlag + 1] : process.cwd();
const positional = args.filter((a, i) => a !== '--dir' && args[i - 1] !== '--dir');
const action = positional[0] || 'status';

const label = (on) => (on ? 'ask mode on' : 'ask mode off');

switch (action) {
  case 'default': {
    const value = positional[1];
    if (value === 'on' || value === 'off') setDefault(value === 'on');
    process.stdout.write(`по умолчанию: ${label(defaultOn())}\n`);
    break;
  }
  case 'reset':
    process.stdout.write(`${label(resetMode(dir))} (по умолчанию)\n`);
    break;
  case 'on':
  case 'off':
    process.stdout.write(`${label(setMode(dir, action === 'on'))}\n`);
    break;
  case 'toggle':
    process.stdout.write(`${label(setMode(dir, !isOn(dir)))}\n`);
    break;
  default: {
    const s = state(dir);
    process.stdout.write(`${label(s.on)} (${s.source})\n`);
  }
}
