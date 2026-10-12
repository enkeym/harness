#!/usr/bin/env node
// Claude Code, Stop: ход с работой, ход за порогом контекста или ответ с вопросом
// пользователю текстом кончились без меню → ход не завершается, модель получает
// причину и задаёт вопрос через AskUserQuestion или передаёт сессию.
// Логика — question-core.mjs.
//
// Не больше одного блока на ход: повторный Stop приходит со
// stop_hook_active: true и пропускается. Любая ошибка → crash в журнал, ход не держится.

import { questionVerdict } from '../question-core.mjs';
import { isEntryPoint } from '../state-core.mjs';
import { runHook } from './hook-io.mjs';

export function check(input) {
  const reason = questionVerdict(input);
  return reason ? { block: reason } : null;
}

if (isEntryPoint(import.meta.url)) runHook(check, 'Stop');
