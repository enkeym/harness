#!/usr/bin/env node
// Claude Code, Stop: ход с работой, ход за порогом контекста или ответ с вопросом
// пользователю текстом кончились без меню → ход не завершается, модель получает
// причину и задаёт вопрос через AskUserQuestion или передаёт сессию.
// Логика — question-core.mjs.
//
// Не больше одного блока на ход: повторный Stop приходит со
// stop_hook_active: true и пропускается. Любая ошибка → выход без вывода.

import { readInput } from './hook-io.mjs';
import { logDecision } from '../hooklog-core.mjs';
import { questionVerdict } from '../question-core.mjs';

readInput((input) => {
  const reason = questionVerdict(input);
  if (reason) {
    logDecision('block', { reason });
    process.stdout.write(JSON.stringify({ decision: 'block', reason }));
  }
  process.exit(0);
});
