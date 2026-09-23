#!/usr/bin/env node
// Переключатель ask mode.
//
//   ask-mode.mjs on | off | toggle        — режим для текущей сессии
//   ask-mode.mjs reset                    — вернуть сессию к режиму по умолчанию
//   ask-mode.mjs default [on|off]         — режим по умолчанию (все новые сессии)
//   ask-mode.mjs status                   — что сейчас и откуда взято
//
// Сессия — CLAUDE_CODE_SESSION_ID (Claude Code передаёт её в Bash). Без неё —
// каталог: --dir <путь>, иначе текущий.

import { state, isOn, setMode, resetMode, defaultOn, setDefault } from '../ask-core.mjs';

const args = process.argv.slice(2);
const dirFlag = args.indexOf('--dir');
const dir = dirFlag !== -1 ? args[dirFlag + 1] : process.cwd();
const positional = args.filter((a, i) => a !== '--dir' && args[i - 1] !== '--dir');
const action = positional[0] || 'status';
const sid = process.env.CLAUDE_CODE_SESSION_ID || '';

const label = (on) => (on ? 'ask mode on' : 'ask mode off');

switch (action) {
  case 'default': {
    const value = positional[1];
    if (value === 'on' || value === 'off') setDefault(value === 'on');
    process.stdout.write(`по умолчанию: ${label(defaultOn())}\n`);
    break;
  }
  case 'reset':
    process.stdout.write(`${label(resetMode(dir, sid))} (по умолчанию)\n`);
    break;
  case 'on':
  case 'off':
    process.stdout.write(`${label(setMode(dir, action === 'on', sid))}\n`);
    break;
  case 'toggle':
    process.stdout.write(`${label(setMode(dir, !isOn(dir, sid), sid))}\n`);
    break;
  default: {
    // Якорь печатаем всегда: расхождение «в статусбаре одно, гард считает
    // другое» диагностируется только так — сравнением якорей.
    const s = state(dir, sid);
    process.stdout.write(`${label(s.on)} (${s.source}) — ${s.anchor}\n`);
  }
}
