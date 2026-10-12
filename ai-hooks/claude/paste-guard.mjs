#!/usr/bin/env node
// Claude Code, UserPromptSubmit: не пустить в контекст промпт длиннее предела.
//
// Счётчик контекста (context-meter, context-step) видит окно уже после того,
// как вставка в него попала — а вернуть её нельзя, она оплачивается каждым
// ходом до конца сессии. Единственная точка, где дамп можно остановить, — до
// отправки: decision 'block' стирает промпт, reason показывается пользователю
// и в контекст не идёт.
//
// Предел и текст — в context-core (PASTE_LIMIT, oversizedPrompt): те же
// пороги, тот же файл, что и у остальных замеров контекста.

import { oversizedPrompt } from '../context-core.mjs';
import { isEntryPoint } from '../state-core.mjs';
import { runHook } from './hook-io.mjs';

export function check(input) {
  const reason = oversizedPrompt(input.prompt);
  return reason ? { block: reason } : null;
}

if (isEntryPoint(import.meta.url)) runHook(check, 'UserPromptSubmit');
