#!/usr/bin/env node
// Тест подсказки о стоимости контекста. Она обязана молчать на обычной работе
// (иначе станет фоном и её перестанут читать) и говорить деньгами, а не
// токенами — «300 КТокенов» ничего не значит, «$0.15 за ход» значит.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SCRIPT = path.join(ROOT, 'claude', 'context-cost.mjs');

let failed = 0;
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  process.stdout.write(`${ok ? 'ok  ' : 'FAIL'} ${name} (got=${JSON.stringify(got)}, want=${JSON.stringify(want)})\n`);
  if (!ok) failed++;
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ctxcost-'));
const home = path.join(tmp, 'home');
fs.mkdirSync(home, { recursive: true });

function transcript(name, model, cacheRead) {
  const file = path.join(tmp, `${name}.jsonl`);
  fs.writeFileSync(file, JSON.stringify({
    type: 'assistant',
    message: { id: 'm1', model, usage: { input_tokens: 5, cache_read_input_tokens: cacheRead, output_tokens: 100 } },
  }) + '\n');
  return file;
}

function run(file, sessionId) {
  const out = execFileSync('node', [SCRIPT], {
    input: JSON.stringify({ session_id: sessionId, transcript_path: file, cwd: '/p', hook_event_name: 'UserPromptSubmit' }),
    encoding: 'utf8',
    env: { ...process.env, HOME: home },
  });
  return out.trim() ? JSON.parse(out).systemMessage : null;
}

// --- молчит на обычной сессии
check('50 КТокенов: молчит', run(transcript('small', 'claude-opus-5', 50_000), 's-small'), null);
check('199 КТокенов: молчит', run(transcript('edge', 'claude-opus-5', 199_000), 's-edge'), null);

// --- говорит на выросшей
const warn = run(transcript('warn', 'claude-opus-5', 300_000), 's-warn');
check('300 КТокенов: предупреждает', warn !== null, true);
check('называет деньги', /\$\d/.test(warn || ''), true);
check('советует /clear', /\/clear/.test(warn || ''), true);

// --- на очень большой добавляет довод против смены модели
const loud = run(transcript('loud', 'claude-opus-5', 900_000), 's-loud');
check('900 КТокенов: объясняет про кеш модели', /кеш привязан к модели/.test(loud || ''), true);

// --- цена считается по модели, а не одна на всех
const opus = run(transcript('p-opus', 'claude-opus-5', 400_000), 's-p1');
const haiku = run(transcript('p-haiku', 'claude-haiku-4-5', 400_000), 's-p2');
const money = (s) => Number((String(s).match(/\$(\d+\.\d+)/) || [])[1]);
check('opus дороже haiku на том же контексте', money(opus) > money(haiku), true);

// --- неизвестная модель: без выдуманной цены, но с токенами
const unknown = run(transcript('unk', 'модель-которой-нет', 400_000), 's-unk');
check('неизвестная модель: без $', /\$/.test(unknown || ''), false);
check('неизвестная модель: с токенами', /КТокенов/.test(unknown || ''), true);

// --- дроссель: подряд не повторяется
const sid = 's-throttle';
const big = transcript('throttle', 'claude-opus-5', 600_000);
const first = run(big, sid);
const second = run(big, sid);
const third = run(big, sid);
check('первый раз говорит', first !== null, true);
check('второй молчит', second, null);
check('третий молчит', third, null);

// --- битый и пустой транскрипт не роняют
{
  const broken = path.join(tmp, 'broken.jsonl');
  fs.writeFileSync(broken, 'не json\n{обрезано\n');
  let crashed = false;
  try { check('битый транскрипт: молчит', run(broken, 's-broken'), null); } catch { crashed = true; }
  check('битый транскрипт: не падает', crashed, false);
  check('нет файла: молчит', run(path.join(tmp, 'нет.jsonl'), 's-none'), null);
}

fs.rmSync(tmp, { recursive: true, force: true });
process.stdout.write(failed ? `\n=== ${failed} FAIL ===\n` : '\n=== все проверки прошли ===\n');
process.exit(failed ? 1 : 0);
