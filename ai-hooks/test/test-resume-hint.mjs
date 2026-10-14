#!/usr/bin/env node
// Тест SessionStart-хука resume-hint: цепочка передач A → B → C ведёт к
// последнему звену, последнее звено и обычный отказ от плана молчат, промпт
// после передачи гасит подсказку, чужой slug и далёкое время звена не дают.

import './env-isolate.mjs';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { check as hintFor } from '../claude/resume-hint.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SCRIPT = path.join(ROOT, 'claude', 'resume-hint.mjs');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'resume-hint-'));

let failed = 0;
const check = (name, ok, detail = '') => {
  process.stdout.write(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}\n`);
  if (!ok) failed++;
};

const T0 = Date.parse('2026-10-14T08:00:00Z');
const at = (min, ms = 0) => new Date(T0 + min * 60_000 + ms).toISOString();

const plan = (min, slug) => ({ type: 'user', slug, planContent: '## Задача\nx', timestamp: at(min, 3),
  message: { role: 'user', content: 'Implement the following plan:\n\n## Задача\nx' } });
const prompt = (min, text) => ({ type: 'user', timestamp: at(min), message: { role: 'user', content: text } });
const exitPlan = (min, id) => ({ type: 'assistant', timestamp: at(min),
  message: { role: 'assistant', content: [{ type: 'tool_use', id, name: 'ExitPlanMode', input: {} }] } });
const rejected = (min, id, slug) => ({ type: 'user', slug, timestamp: at(min), toolDenialKind: 'user-rejected',
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, is_error: true, content: 'rejected' }] } });
const interrupted = (min) => prompt(min, '[Request interrupted by user for tool use]');
const title = (t) => ({ type: 'ai-title', aiTitle: t });
const handoff = (min, id, slug = 's') => [exitPlan(min, id), rejected(min, id, slug), interrupted(min)];

function write(name, records) {
  const file = path.join(dir, `${name}.jsonl`);
  fs.writeFileSync(file, records.map((r) => JSON.stringify(r)).join('\n') + '\n');
  return file;
}

const A = write('a', [{ type: 'mode' }, prompt(0, 'сделай'), title('alpha'), ...handoff(10, 't1')]);
write('b', [{ type: 'file-history-snapshot' }, plan(10, 's'), title('beta'), ...handoff(20, 't2')]);
const C = write('c', [plan(20, 's'), title('gamma'), prompt(30, 'ещё')]);
// Обычный отказ от плана: звена нет.
const R = write('r', [prompt(40, 'план'), ...handoff(50, 't3', 'q')]);
// После передачи работа осознанно продолжена здесь же.
const P = write('p', [prompt(60, 'x'), ...handoff(70, 't4', 'p'), prompt(80, 'продолжи тут')]);
write('p2', [plan(70, 'p'), title('p-child')]);
// Звено с чужим slug и звено через минуту после отказа — не продолжение.
const S = write('s', [prompt(90, 'x'), ...handoff(100, 't5', 'own')]);
write('s2', [plan(100, 'other'), title('foreign')]);
write('s3', [{ ...plan(101, 'own') }, title('late')]);

const resume = (file) => hintFor({ source: 'resume', transcript_path: file });

const hint = resume(A);
check('A → последнее звено C через два', hint?.message.includes('/resume c') && hint.message.includes('«gamma»')
  && hint.message.includes('звеньев после этой: 2'), hint?.message);
check('модели — тот же id в контексте', hint?.context.includes('сессии c ') && hint.context.includes('/resume c'));
check('последнее звено молчит', resume(C) === null);
check('отклонённый план без звена молчит', resume(R) === null);
check('промпт после передачи гасит подсказку', resume(P) === null);
check('чужой slug и далёкое время — не звено', resume(S) === null);
check('не resume — молчит', hintFor({ source: 'startup', transcript_path: A }) === null);
check('нет транскрипта — молчит', resume(path.join(dir, 'none.jsonl')) === null);

const run = (input) => execFileSync('node', [SCRIPT], { input, encoding: 'utf8' });
const out = JSON.parse(run(JSON.stringify({ source: 'resume', hook_event_name: 'SessionStart', transcript_path: A })));
check('скрипт: systemMessage и additionalContext', out.systemMessage?.includes('/resume c')
  && out.hookSpecificOutput?.hookEventName === 'SessionStart'
  && out.hookSpecificOutput.additionalContext?.startsWith('resume-hint:'));
check('скрипт: последнее звено — пустой вывод', run(JSON.stringify({ source: 'resume', transcript_path: C })) === '');
check('скрипт: битый stdin — пустой вывод', run('{') === '');

fs.rmSync(dir, { recursive: true, force: true });
process.stdout.write(failed ? `\n${failed} FAIL\n` : '\nвсе проверки прошли\n');
process.exit(failed ? 1 : 0);
