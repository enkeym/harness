#!/usr/bin/env node
// Тест замера контекста и порога передачи. Смысл проверок: цифра должна браться
// из фактического usage последнего хода основной нити (а не субагента), молчать
// до порога, объявляться один раз и не пропустить переход к требованию.

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

// Состояние — в песочницу, окно — фиксированное: иначе проверки зависят от того,
// что осталось от предыдущего прогона и от env машины.
process.env.AI_HOOKS_STATE_DIR = stateDir;
process.env.AI_HOOKS_CONTEXT_WINDOW = '200000';
const { contextUsed, contextNotice, level, WINDOW } = await import('../context-core.mjs');

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
    env: { ...process.env, AI_HOOKS_STATE_DIR: stateDir, AI_HOOKS_CONTEXT_WINDOW: '200000' },
  });
  return out.trim() ? JSON.parse(out).hookSpecificOutput.additionalContext : null;
}

const pctTokens = (pct) => Math.round(WINDOW * pct / 100);

// --- нечего мерить: молчим, а не гадаем
check('нет пути: null', contextUsed(undefined), null);
check('нет файла: null', contextUsed(path.join(tmp, 'нет.jsonl')), null);
check('пустой транскрипт: null', contextUsed(transcript('empty', [])), null);
check('без usage: null', contextUsed(transcript('nousage', ['{"type":"user"}', 'не json'])), null);

// --- цифра из последнего хода, а не из первого
{
  const file = transcript('grow', [assistant(pctTokens(20)), assistant(pctTokens(50))]);
  const used = contextUsed(file);
  check('берётся последний ход', used.pct, 50);
  check('токены сходятся', used.tokens, pctTokens(50));
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
    assistant(pctTokens(70)),
    assistant(pctTokens(5), { isSidechain: true }),
  ]);
  check('sidechain пропущен', contextUsed(file).pct, 70);
}

// --- хвост: длинный транскрипт не читается целиком, но цифра та же
{
  const filler = Array.from({ length: 400 }, () => JSON.stringify({ type: 'user', text: 'x'.repeat(1000) }));
  const file = transcript('long', [...filler, assistant(pctTokens(80))]);
  check('файл больше хвоста', fs.statSync(file).size > 256 * 1024, true);
  check('хвост даёт ту же цифру', contextUsed(file).pct, 80);
}

// --- пороги
check('59% — молчим', level(59), null);
check('60% — предупреждение', level(60), 'warn');
check('74% — всё ещё предупреждение', level(74), 'warn');
check('75% — требование', level(75), 'act');

// --- ниже порога хук молчит
{
  const file = transcript('quiet', [assistant(pctTokens(40))]);
  check('40%: уведомления нет', contextNotice({ transcript_path: file, session_id: 's-quiet' }), null);
  check('40%: хук молчит', runHook({ transcript_path: file, session_id: 's-quiet' }), null);
}

// --- предупреждение: один раз, пока не вырос на пять пунктов
{
  const file = transcript('warn', [assistant(pctTokens(62))]);
  const first = contextNotice({ transcript_path: file, session_id: 's-warn' });
  check('62%: уровень warn', first.level, 'warn');
  check('62%: назван порог передачи', /75%/.test(first.text), true);
  check('62%: процент в тексте', /62%/.test(first.text), true);
  check('повтор на том же проценте молчит', contextNotice({ transcript_path: file, session_id: 's-warn' }), null);

  const nudge = transcript('warn2', [assistant(pctTokens(64))]);
  check('+2 п.п. — всё ещё молчим', contextNotice({ transcript_path: nudge, session_id: 's-warn' }), null);

  const grown = transcript('warn3', [assistant(pctTokens(68))]);
  check('+6 п.п. — говорим снова', contextNotice({ transcript_path: grown, session_id: 's-warn' }).pct, 68);
}

// --- переход warn → act объявляется сразу: это смена требования, а не ещё
// несколько процентов
{
  const warn = transcript('cross1', [assistant(pctTokens(73))]);
  const act = transcript('cross2', [assistant(pctTokens(75))]);
  check('73%: warn', contextNotice({ transcript_path: warn, session_id: 's-cross' }).level, 'warn');
  const crossed = contextNotice({ transcript_path: act, session_id: 's-cross' });
  check('75% сразу после 73%: объявлено', crossed?.level, 'act');
  check('act: назван скилл handoff', /handoff/.test(crossed.text), true);
  check('act: назван /clear', /\/clear/.test(crossed.text), true);
  check('act: сказано сначала закоммитить', /[Зз]акоммит/.test(crossed.text), true);
}

// --- сессии не делят состояние объявлений
{
  const file = transcript('two', [assistant(pctTokens(80))]);
  check('первая сессия слышит', contextNotice({ transcript_path: file, session_id: 's-a' }).level, 'act');
  check('вторая сессия тоже слышит', contextNotice({ transcript_path: file, session_id: 's-b' }).level, 'act');
}

// --- хук: доносит текст и не падает на мусоре
{
  const file = transcript('hook', [assistant(pctTokens(90))]);
  check('хук отдаёт текст', /90%/.test(runHook({ transcript_path: file, session_id: 's-hook' })), true);
  const broken = execFileSync('node', [HOOK], {
    input: 'не json',
    encoding: 'utf8',
    env: { ...process.env, AI_HOOKS_STATE_DIR: stateDir },
  });
  check('битый ввод: пустой ответ', broken.trim(), '');
  const noPath = execFileSync('node', [HOOK], {
    input: JSON.stringify({ session_id: 's-nopath' }),
    encoding: 'utf8',
    env: { ...process.env, AI_HOOKS_STATE_DIR: stateDir },
  });
  check('нет транскрипта: пустой ответ', noPath.trim(), '');
}

fs.rmSync(tmp, { recursive: true, force: true });
process.stdout.write(failed ? `\n=== ${failed} FAIL ===\n` : '\n=== все проверки прошли ===\n');
process.exit(failed ? 1 : 0);
