#!/usr/bin/env node
// Тесты учёта токенов. Ошибка здесь не падает, а тихо врёт: цифра выглядит
// правдоподобно, и по ней принимают решения. Поэтому проверяются те места,
// где легко ошибиться незаметно — дедупликация сообщений, арифметика цены,
// кеш записи двух видов, обход транскриптов субагентов и upsert по сессии.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { summarize, upsert, PRICES } from '../claude/usage-log.mjs';

let failed = 0;
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  process.stdout.write(`${ok ? 'ok  ' : 'FAIL'} ${name} (got=${JSON.stringify(got)}, want=${JSON.stringify(want)})\n`);
  if (!ok) failed++;
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-test-'));

function line(model, id, usage, content = []) {
  return JSON.stringify({
    type: 'assistant',
    timestamp: new Date().toISOString(),
    message: { id, model, usage, content },
  });
}

function transcript(name, lines) {
  const file = path.join(tmp, `${name}.jsonl`);
  fs.writeFileSync(file, lines.join('\n') + '\n');
  return file;
}

const usage = (o = {}) => ({
  input_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 0, ...o,
});

// --- 1. Одно сообщение считается один раз, сколько бы строк оно ни занимало.
// Claude Code пишет по строке на блок контента, и в каждой полный usage —
// наивная сумма завысила бы расход кратно числу блоков.
{
  const u = usage({ input_tokens: 10, output_tokens: 1000 });
  const file = transcript('dedup', [
    line('claude-sonnet-5', 'msg_1', u, [{ type: 'text' }]),
    line('claude-sonnet-5', 'msg_1', u, [{ type: 'tool_use', name: 'Bash' }]),
    line('claude-sonnet-5', 'msg_1', u, [{ type: 'tool_use', name: 'Read' }]),
  ]);
  const r = summarize({ session_id: 'dedup', transcript_path: file, cwd: '/p' });
  check('дедупликация: сообщений', r.models['claude-sonnet-5'].messages, 1);
  check('дедупликация: выход не умножен', r.models['claude-sonnet-5'].output, 1000);
  check('вызовы инструментов считаются все', r.tools, { Bash: 1, Read: 1 });
}

// --- 2. Цена считается по прайсу, а не на глаз.
{
  const p = PRICES['claude-sonnet-5'];
  const file = transcript('price', [
    line('claude-sonnet-5', 'm1', usage({
      input_tokens: 1_000_000, cache_read_input_tokens: 1_000_000,
      cache_creation_input_tokens: 1_000_000, output_tokens: 1_000_000,
    })),
  ]);
  const r = summarize({ session_id: 'price', transcript_path: file, cwd: '/p' });
  const expected = Math.round((p.input + p.cacheRead + p.cacheWrite5m + p.output) * 10000) / 10000;
  check('цена по миллиону каждого вида', r.models['claude-sonnet-5'].cost, expected);
  check('итог сессии равен сумме моделей', r.cost, expected);
}

// --- 3. Часовой кеш дороже пятиминутного и не путается с ним.
{
  const p = PRICES['claude-sonnet-5'];
  const file = transcript('cache1h', [
    line('claude-sonnet-5', 'm1', {
      ...usage(),
      cache_creation_input_tokens: 1_000_000,
      cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 1_000_000 },
    }),
  ]);
  const r = summarize({ session_id: 'cache1h', transcript_path: file, cwd: '/p' });
  const m = r.models['claude-sonnet-5'];
  check('часовой кеш учтён отдельно', [m.cacheWrite5m, m.cacheWrite1h], [0, 1_000_000]);
  check('часовой кеш оценён по своей ставке', m.cost, Math.round(p.cacheWrite1h * 10000) / 10000);
}

// --- 4. Неизвестная модель помечается, а не оценивается наугад.
{
  const file = transcript('unknown', [line('gpt-неизвестно', 'm1', usage({ output_tokens: 5000 }))]);
  const r = summarize({ session_id: 'unknown', transcript_path: file, cwd: '/p' });
  check('неизвестная модель: не оценена', r.models['gpt-неизвестно'].priced, false);
  check('неизвестная модель: не врёт ценой', r.cost, 0);
  check('токены всё равно посчитаны', r.models['gpt-неизвестно'].output, 5000);
}

// --- 5. Транскрипты субагентов попадают в ту же сессию.
{
  const sid = 'withsub';
  const main = transcript(sid, [line('claude-opus-5', 'm1', usage({ output_tokens: 100 }))]);
  const subDir = path.join(tmp, sid, 'subagents');
  fs.mkdirSync(subDir, { recursive: true });
  fs.writeFileSync(path.join(subDir, 'agent-a.jsonl'),
    line('claude-haiku-4-5', 's1', usage({ output_tokens: 200 }), [{ type: 'tool_use', name: 'Glob' }]) + '\n');
  fs.writeFileSync(path.join(subDir, 'agent-b.jsonl'),
    line('claude-haiku-4-5', 's2', usage({ output_tokens: 300 })) + '\n');
  const r = summarize({ session_id: sid, transcript_path: main, cwd: '/p' });
  check('субагенты посчитаны', r.subagents, 2);
  check('их модель отдельной строкой', r.models['claude-haiku-4-5'].output, 500);
  check('их инструменты в общем счёте', r.tools.Glob, 1);
}

// --- 6. Мусор и пропуски не роняют учёт.
{
  const file = transcript('junk', [
    'не json',
    JSON.stringify({ type: 'user', message: { content: 'привет' } }),
    JSON.stringify({ type: 'assistant', message: { id: 'no-usage', model: 'claude-sonnet-5' } }),
    line('claude-sonnet-5', 'ok', usage({ output_tokens: 7 })),
  ]);
  let crashed = false;
  let r = null;
  try { r = summarize({ session_id: 'junk', transcript_path: file, cwd: '/p' }); } catch { crashed = true; }
  check('мусор не роняет', crashed, false);
  check('считается только валидное', r?.models['claude-sonnet-5'].output, 7);
}

// --- 7. Пустой и отсутствующий транскрипт дают null, а не пустую запись.
{
  check('нет файла — null', summarize({ session_id: 'x', transcript_path: path.join(tmp, 'нет.jsonl'), cwd: '/p' }), null);
  check('нет session_id — null', summarize({ transcript_path: transcript('empty2', ['{}']), cwd: '/p' }), null);
}

// --- 8. Upsert заменяет запись сессии, а не копит дубликаты.
{
  const file = path.join(tmp, 'usage.jsonl');
  upsert({ session_id: 's1', cost: 1, ended: '2026-01-01T00:00:00Z' }, file);
  upsert({ session_id: 's2', cost: 2, ended: '2026-01-01T00:00:00Z' }, file);
  upsert({ session_id: 's1', cost: 5, ended: '2026-01-02T00:00:00Z' }, file);
  const recs = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(JSON.parse);
  check('upsert: записей по числу сессий', recs.length, 2);
  check('upsert: значение обновлено', recs.find((r) => r.session_id === 's1').cost, 5);
  check('upsert: соседняя не задета', recs.find((r) => r.session_id === 's2').cost, 2);
}

// --- 9. Источники контекста: размер tool_result привязан к инструменту по id,
// для Read — к файлу; строка и массив блоков считаются одинаково; результат
// без парного tool_use не теряется, а идёт в unknown.
{
  const use = (id, name, input = {}) => ({ type: 'tool_use', id, name, input });
  const result = (tool_use_id, content) => JSON.stringify({
    type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id, content }] },
  });
  const file = transcript('sources', [
    JSON.stringify({ type: 'user', message: { role: 'user', content: 'обычный промпт' } }),
    line('claude-sonnet-5', 'm1', usage(), [use('t1', 'Read', { file_path: '/p/a.ts' })]),
    result('t1', 'x'.repeat(400)),
    line('claude-sonnet-5', 'm2', usage(), [use('t2', 'Read', { file_path: '/p/a.ts' })]),
    result('t2', [{ type: 'text', text: 'y'.repeat(100) }, { type: 'image' }]),
    line('claude-sonnet-5', 'm3', usage(), [use('t3', 'Bash', { command: 'ls' })]),
    result('t3', [{ type: 'text', text: 'z'.repeat(50) }]),
    result('нет-такого', 'q'.repeat(10)),
  ]);
  const r = summarize({ session_id: 'sources', transcript_path: file, cwd: '/p' });
  check('источники: по инструменту', r.context_sources.tools, {
    Read: { calls: 2, chars: 500 }, Bash: { calls: 1, chars: 50 }, unknown: { calls: 1, chars: 10 },
  });
  check('источники: Read по файлу суммируется', r.context_sources.files, { '/p/a.ts': 500 });
  check('источники: вызовы инструментов не задеты', r.tools, { Read: 2, Bash: 1 });
}

fs.rmSync(tmp, { recursive: true, force: true });
process.stdout.write(failed ? `\n=== ${failed} FAIL ===\n` : '\n=== все проверки прошли ===\n');
process.exit(failed ? 1 : 0);
