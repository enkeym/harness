#!/usr/bin/env node
// Тесты question-guard: ответ, который кончается вопросом или ожиданием
// решения пользователя текстом, блокирует Stop; вопрос через меню, код, цитата,
// заголовок, условие без просьбы решения, повторный Stop — нет.
// Хук гоняется настоящим процессом на временном транскрипте.

import { ISOLATED_HOOKS_LOG } from './env-isolate.mjs';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const HOOK = path.join(ROOT, 'claude', 'question-guard.mjs');
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'question-guard-test-'));

let failed = 0;
function check(name, ok, detail = '') {
  process.stdout.write(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok || !detail ? '' : ` — ${detail}`}\n`);
  if (!ok) failed++;
}

const prompt = (text) => ({ type: 'user', message: { role: 'user', content: text } });
const say = (text) => ({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } });
const call = (name) => ({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: `t-${name}`, name, input: {} }] } });
const result = (name) => ({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `t-${name}`, content: 'ok' }] } });

let n = 0;
function run(records, extra = {}) {
  const transcript = path.join(DIR, `t${n++}.jsonl`);
  fs.writeFileSync(transcript, records.map((r) => JSON.stringify(r)).join('\n') + '\n');
  const input = JSON.stringify({ session_id: `test-${process.pid}`, transcript_path: transcript, hook_event_name: 'Stop', ...extra });
  const r = spawnSync('node', [HOOK], { input, encoding: 'utf8' });
  if (r.status !== 0) return { error: r.stderr };
  return r.stdout ? JSON.parse(r.stdout) : null;
}

const blocked = (out) => out?.decision === 'block' && typeof out.reason === 'string' && out.reason.includes('AskUserQuestion');

// Вопрос в конце → block, решение в журнале.
{
  const out = run([prompt('почини'), say('Починил.\n\nКоммитить сейчас?')]);
  check('вопрос последней строкой — block', blocked(out), JSON.stringify(out));
  const log = fs.existsSync(ISOLATED_HOOKS_LOG) ? fs.readFileSync(ISOLATED_HOOKS_LOG, 'utf8') : '';
  check('block в журнале', log.includes('"hook":"question-guard"') && log.includes('"decision":"block"'), log);
}

// Разметка, знаки и эмодзи после `?` не прячут вопрос.
for (const tail of ['**Какой вариант берём?**', '(коммитить?)', '«Пушить?»', 'Пушить? 🙂', 'Пушить?  \n\n']) {
  check(`хвост ${JSON.stringify(tail)} — block`, blocked(run([prompt('x'), say(`Итог.\n\n${tail}`)])));
}

// Вопрос в последнем абзаце, после него пояснение; вопрос последним пунктом списка.
check('вопрос и пояснение в последнем абзаце — block', blocked(run([prompt('x'),
  say('Сделал.\n\nКоммитить сейчас?\nТесты зелёные, дерево чистое.')])));
check('вопрос последним пунктом — block', blocked(run([prompt('x'),
  say('Итог:\n\n- хук поправлен\n- пушить?')])));

// Варианты списком после вопроса.
check('список вариантов после вопроса — block', blocked(run([prompt('x'),
  say('Есть два пути. Какой выбрать?\n\n1. Блокировать ход\n2. Только подсказка')])));

// Варианты без `?`.
check('«Варианты:» и список — block', blocked(run([prompt('x'),
  say('Разобрался.\n\nВарианты:\n\n1) блокировать\n2) подсказка')])));
check('«Варианты: 1) … 2) …» строкой — block', blocked(run([prompt('x'),
  say('Разобрался.\n\nВарианты: 1) блокировать 2) подсказка.')])));
check('«Можно A или B» — block', blocked(run([prompt('x'),
  say('Тест падает из-за кэша.\n\nМожно сбрасывать кэш или убрать его совсем.')])));
check('«Можно было A или B» — пропуск', run([prompt('x'),
  say('Можно было сбрасывать кэш или убрать его, убрал.')]) === null);

// Ожидание решения в форме утверждения — случай, ради которого AWAIT_RE.
for (const tail of [
  'Как скажете „ок“ по каждой, прогоню ревью и закоммичу.',
  'Жду вашего «ок».',
  'Напишите, когда проверите.',
  'Дайте знать, если нужен другой текст.',
  'Подтвердите, и я запушу.',
  'Если согласны — сделаю так же в остальных хуках.',
  'Могу также покрыть тестами адаптер, если хотите.',
  'Если нужно — могу разнести на два коммита.',
  'Let me know if the wording works.',
  'Should I push it now.',
  'Want me to add the adapter test as well.',
]) {
  check(`ожидание «${tail}» — block`, blocked(run([prompt('x'), say(`Сделал, тесты зелёные.\n\n${tail}`)])));
}

// Причина цитирует строку, на которой хук сработал.
{
  const out = run([prompt('x'), say('Готово.\n\nЖду вашего ок — закоммичу.')]);
  check('причина цитирует строку', blocked(out) && out.reason.includes('«Жду вашего ок — закоммичу.»'), JSON.stringify(out));
}

// Повторный Stop — модель уже получила причину.
check('stop_hook_active — пропуск',
  run([prompt('x'), say('Коммитить?')], { stop_hook_active: true }) === null);

// `?` внутри кода и цитаты — не вопрос пользователю.
check('вопрос в ```-блоке — пропуск',
  run([prompt('x'), say('Регэксп готов:\n\n```js\nconst re = /a?/;\nconst ok = x ?\n```')]) === null);
check('вопрос в `инлайн-коде` — пропуск', run([prompt('x'), say('Добавил `a?.b ?? c?`')]) === null);
check('вопрос в цитате — пропуск', run([prompt('x'), say('Пользователь спросил:\n\n> а тесты зелёные?')]) === null);
check('тип `foo?: string` — пропуск', run([prompt('x'), say('Поле стало необязательным: `foo?: string`')]) === null);
check('URL с параметрами в конце — пропуск', run([prompt('x'), say('Деплой тут: https://x/y?z=1')]) === null);
check('заголовок-вопрос — пропуск', run([prompt('x'),
  say('## Что сломалось?\nКэш не сбрасывался.\n\n## Итог\nПочинил, тесты зелёные.')]) === null);
check('условие без просьбы решения — пропуск', run([prompt('x'),
  say('Текст ошибки обновлён.\n\nЕсли бэкенд ответит иначе, поправим текст.')]) === null);
check('фраза ожидания в кавычках — пропуск', run([prompt('x'),
  say('Хук теперь ловит «Дайте знать» и «Жду вашего ок».')]) === null);

// Вопрос уже задан меню в этом ходе.
check('ход с AskUserQuestion — пропуск', run([prompt('x'), call('AskUserQuestion'), result('AskUserQuestion'),
  say('Беру первый. Всё верно?')]) === null);
check('ход с ExitPlanMode — пропуск', run([prompt('x'), call('ExitPlanMode'), result('ExitPlanMode'),
  say('План готов?')]) === null);

// Меню в прошлом ходе не прощает вопрос в этом.
check('AskUserQuestion в прошлом ходе — block', blocked(run([prompt('a'), call('AskUserQuestion'),
  result('AskUserQuestion'), say('Сделал.'), prompt('b'), say('Пушить?')])));

// Обычный ответ, список без вопроса, вопрос в середине.
check('обычный ответ — пропуск', run([prompt('x'), say('Готово: тесты зелёные, коммит запушен.')]) === null);
check('«Готово.» — пропуск', run([prompt('x'), say('Готово.')]) === null);
check('только вызовы инструментов — пропуск', run([prompt('x'), call('Bash'), result('Bash')]) === null);
check('список без вопроса — пропуск', run([prompt('x'), say('Сделано:\n\n- хук\n- тест')]) === null);
check('вопрос в середине — пропуск', run([prompt('x'), say('Почему падало? Кэш не сбрасывался.\n\nПочинил.')]) === null);

// last_assistant_message свежее транскрипта.
check('last_assistant_message — block',
  blocked(run([prompt('x'), say('Готово.')], { last_assistant_message: 'Готово. Пушить?' })));

// Битые строки транскрипта пропускаются, пустой транскрипт — тишина.
{
  const transcript = path.join(DIR, 'broken.jsonl');
  fs.writeFileSync(transcript, `{битая\n${JSON.stringify(prompt('x'))}\n${JSON.stringify(say('Готово.'))}\n{обреза`);
  const r = spawnSync('node', [HOOK], { input: JSON.stringify({ transcript_path: transcript }), encoding: 'utf8' });
  check('битые строки — пропуск', r.status === 0 && r.stdout === '', r.stderr || r.stdout);
  fs.writeFileSync(transcript, '');
  const e = spawnSync('node', [HOOK], { input: JSON.stringify({ transcript_path: transcript }), encoding: 'utf8' });
  check('пустой транскрипт — пропуск', e.status === 0 && e.stdout === '', e.stderr || e.stdout);
}

// Нет транскрипта — тишина, не падение.
{
  const r = spawnSync('node', [HOOK], { input: JSON.stringify({ transcript_path: path.join(DIR, 'none.jsonl') }), encoding: 'utf8' });
  check('транскрипта нет — пропуск', r.status === 0 && r.stdout === '', r.stderr);
}

process.stdout.write(failed ? `\n=== ${failed} проверок упало ===\n` : '\n=== все проверки прошли ===\n');
process.exit(failed ? 1 : 0);
