#!/usr/bin/env node
// Claude Code, UserPromptSubmit: один раз сказать агенту собрать блок передачи
// в чат, когда контекст дорос до порога.
//
// Скилл не умеет запускаться сам по счётчику токенов — триггер может дать только
// хук. Отсюда разделение: хук знает, КОГДА (порог из context-core), скилл знает,
// ЧТО собрать в блок; переносит блок в новую сессию и очищает контекст человек —
// файлов передача не создаёт, `/clear` программно не вызывается.
//
// UserPromptSubmit, а не Stop: additionalContext доезжает до модели именно здесь.
//
// Этот хук видит только границы ходов. Внутри одного хода окно растёт на сотни
// тысяч токенов — там считает `context-step.mjs` на PostToolUse, фаза 'step'.

import { contextNotice } from '../context-core.mjs';
import { isEntryPoint } from '../state-core.mjs';
import { runHook } from './hook-io.mjs';

export function check(input) {
  const notice = contextNotice(input);
  return notice ? { context: notice.text } : null;
}

if (isEntryPoint(import.meta.url)) runHook(check, 'UserPromptSubmit');
