#!/usr/bin/env node
// Claude Code, PostToolUse (правки, Bash) и PostToolUseFailure (Bash): Sonnet
// трижды подряд провалил одну проверку с правками между попытками — раз за
// сессию подсказать пользователю `/model opus`, модели — предложить его в меню.
// Адаптер: формат хука Claude ↔ ядро model-hint-core.mjs:noteCheck.

import { noteCheck } from '../model-hint-core.mjs';
import { isEntryPoint } from '../state-core.mjs';
import { runHook } from './hook-io.mjs';

export function check(input) {
  return noteCheck(input);
}

if (isEntryPoint(import.meta.url)) runHook(check);
