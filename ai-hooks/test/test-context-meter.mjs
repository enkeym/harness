#!/usr/bin/env node
// Тест замера контекста и порогов передачи. Смысл проверок: цифра должна браться
// из фактического usage последнего хода основной нити (а не субагента), пороги
// считаться в токенах (а не в доле окна), каждый порог звучать один раз, а
// верхний — повторяться каждый ход, пока сессия не сменится. Файлов передача не
// создаёт, `/clear` не зовёт.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const HOOK = path.join(ROOT, 'claude', 'context-meter.mjs');

let failed = 0;
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  process.stdout.write(`${ok ? 'ok  ' : 'FAIL'} ${name} (got=${JSON.stringify(got)}, want=${JSON.stringify(want)})\n`);
  if (!ok) failed++;
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-meter-'));
const stateDir = path.join(tmp, 'state');

// Состояние — в песочницу, окно и пороги — фиксированные: иначе проверки зависят
// от того, что осталось от предыдущего прогона, и от env машины.
const ENV = {
  AI_HOOKS_STATE_DIR: stateDir,
  AI_HOOKS_CONTEXT_WINDOW: '1000000',
  AI_HOOKS_CTX_SOFT: '90000',
  AI_HOOKS_CTX_HAND: '150000',
  AI_HOOKS_CTX_HARD: '220000',
};
Object.assign(process.env, ENV);
const { contextUsed, contextNotice, level, WINDOW, SOFT, HAND, HARD } = await import('../context-core.mjs');

let seq = 0;
function assistant(tokens, extra = {}) {
  return JSON.stringify({
    type: 'assistant',
    ...extra,
    message: {
      id: `m${++seq}`,
      model: 'claude-opus-5',
      content: [],
      usage: {
        input_tokens: 10,
        cache_read_input_tokens: tokens - 10,
        cache_creation_input_tokens: 0,
        output_tokens: 0,
      },
    },
  });
}

function transcript(name, lines) {
  const file = path.join(tmp, `${name}.jsonl`);
  fs.writeFileSync(file, lines.join('\n') + '\n');
  return file;
}

function runHook(input) {
  const out = execFileSync('node', [HOOK], {
    input: JSON.stringify(input),
    encoding: 'utf8',
    env: { ...process.env, ...ENV },
  });
  return out.trim() ? JSON.parse(out).hookSpecificOutput.additionalContext : null;
}

// --- нечего мерить: молчим, а не гадаем
check('нет пути: null', contextUsed(undefined), null);
check('нет файла: null', contextUsed(path.join(tmp, 'нет.jsonl')), null);
check('пустой транскрипт: null', contextUsed(transcript('empty', [])), null);
check('без usage: null', contextUsed(transcript('nousage', ['{"type":"user"}', 'не json'])), null);

// --- цифра из последнего хода, а не из первого
{
  const file = transcript('grow', [assistant(50_000), assistant(120_000)]);
  const used = contextUsed(file);
  check('берётся последний ход', used.tokens, 120_000);
  check('процент считается от окна', used.pct, Math.round(120_000 / WINDOW * 100));
  check('модель названа', used.model, 'claude-opus-5');
}

// --- все четыре слагаемых usage складываются: кеш — тоже прочитанный контекст
{
  const file = transcript('parts', [JSON.stringify({
    type: 'assistant',
    message: {
      id: 'p1',
      model: 'claude-opus-5',
      content: [],
      usage: {
        input_tokens: 1000,
        cache_read_input_tokens: 100_000,
        cache_creation_input_tokens: 20_000,
        output_tokens: 3000,
      },
    },
  })]);
  check('сумма всех частей usage', contextUsed(file).tokens, 124_000);
}

// --- субагент считает свой контекст: его запись лежит последней ровно там, где
// контекст основной нити вырос сильнее всего
{
  const file = transcript('side', [
    assistant(180_000),
    assistant(9_000, { isSidechain: true }),
  ]);
  check('sidechain пропущен', contextUsed(file).tokens, 180_000);
}

// --- хвост: длинный транскрипт не читается целиком, но цифра та же
{
  const filler = Array.from({ length: 400 }, () => JSON.stringify({ type: 'user', text: 'x'.repeat(1000) }));
  const file = transcript('long', [...filler, assistant(160_000)]);
  check('файл больше хвоста', fs.statSync(file).size > 256 * 1024, true);
  check('хвост даёт ту же цифру', contextUsed(file).tokens, 160_000);
}

// --- пороги считаются в токенах: доля окна на них не влияет
check('ниже SOFT — молчит', level(SOFT - 1), null);
check('SOFT — soft', level(SOFT), 'soft');
check('ниже HAND — всё ещё soft', level(HAND - 1), 'soft');
check('HAND — hand', level(HAND), 'hand');
check('ниже HARD — всё ещё hand', level(HARD - 1), 'hand');
check('HARD — hard', level(HARD), 'hard');
check('220k при 1M-окне — это 22%, и всё равно hard', level(220_000), 'hard');

// --- ниже первого порога хук молчит
{
  const file = transcript('quiet', [assistant(40_000)]);
  check('40k: уведомления нет', contextNotice({ transcript_path: file, session_id: 's-quiet' }), null);
  check('40k: хук молчит', runHook({ transcript_path: file, session_id: 's-quiet' }), null);
}

// --- первый порог: закрыть шаг, но блок ещё не собирать; звучит один раз
{
  const file = transcript('soft', [assistant(95_000)]);
  const first = contextNotice({ transcript_path: file, session_id: 's-soft' });
  check('95k: сработало как soft', first.stage, 'soft');
  check('95k: токены в тексте', /95k/.test(first.text), true);
  check('95k: про handoff пока не просит', /handoff/.test(first.text), false);
  check('95k: сказано закрыть шаг коммитом', /коммит/.test(first.text), true);
  check('повтор того же порога молчит', contextNotice({ transcript_path: file, session_id: 's-soft' }), null);
}

// --- второй порог звучит поверх первого, третий — поверх второго
{
  const soft = transcript('esc-soft', [assistant(95_000)]);
  const hand = transcript('esc-hand', [assistant(160_000)]);
  const hard = transcript('esc-hard', [assistant(240_000)]);

  check('сначала soft', contextNotice({ transcript_path: soft, session_id: 's-esc' }).stage, 'soft');

  const second = contextNotice({ transcript_path: hand, session_id: 's-esc' });
  check('рост до 160k: звучит hand', second.stage, 'hand');
  check('160k: назван скилл handoff', /handoff/.test(second.text), true);
  check('160k: сказано выдать в чат', /чат/.test(second.text), true);
  check('160k: про /clear не просит', /\/clear/.test(second.text), false);
  check('160k: назван resume с id сессии', /--resume s-esc/.test(second.text), true);
  check('hand второй раз молчит', contextNotice({ transcript_path: hand, session_id: 's-esc' }), null);

  const third = contextNotice({ transcript_path: hard, session_id: 's-esc' });
  check('рост до 240k: звучит hard', third.stage, 'hard');
  check('240k: повторяется каждый ход', contextNotice({ transcript_path: hard, session_id: 's-esc' }).stage, 'hard');
  check('240k: и на третий ход тоже', contextNotice({ transcript_path: hard, session_id: 's-esc' }).stage, 'hard');
  check('240k: не начинать новую работу', /[Нн]овую работу не начинай/.test(third.text), true);

  // откат ниже порога (новый ход дешевле предыдущего) младший порог не будит
  check('спуск к 160k после hard: молчит', contextNotice({ transcript_path: hand, session_id: 's-esc' }), null);
  check('спуск к 95k после hard: молчит', contextNotice({ transcript_path: soft, session_id: 's-esc' }), null);
}

// --- сессия, начатая сразу в дорогой зоне, слышит верхний порог без младших
{
  const file = transcript('cold', [assistant(300_000)]);
  check('старт с 300k: сразу hard', contextNotice({ transcript_path: file, session_id: 's-cold' }).stage, 'hard');
}

// --- сессии не делят состояние объявлений
{
  const file = transcript('two', [assistant(160_000)]);
  check('первая сессия слышит', contextNotice({ transcript_path: file, session_id: 's-a' }).stage, 'hand');
  check('вторая сессия тоже слышит', contextNotice({ transcript_path: file, session_id: 's-b' }).stage, 'hand');
  check('первая второй раз — молчит', contextNotice({ transcript_path: file, session_id: 's-a' }), null);
}

// --- хук: доносит текст и не падает на мусоре
{
  const file = transcript('hook', [assistant(175_000)]);
  check('хук отдаёт текст', /175k/.test(runHook({ transcript_path: file, session_id: 's-hook' })), true);
  const broken = execFileSync('node', [HOOK], {
    input: 'не json',
    encoding: 'utf8',
    env: { ...process.env, ...ENV },
  });
  check('битый ввод: пустой ответ', broken.trim(), '');
  const noPath = execFileSync('node', [HOOK], {
    input: JSON.stringify({ session_id: 's-nopath' }),
    encoding: 'utf8',
    env: { ...process.env, ...ENV },
  });
  check('нет транскрипта: пустой ответ', noPath.trim(), '');
}

fs.rmSync(tmp, { recursive: true, force: true });
process.stdout.write(failed ? `\n=== ${failed} FAIL ===\n` : '\n=== все проверки прошли ===\n');
process.exit(failed ? 1 : 0);
