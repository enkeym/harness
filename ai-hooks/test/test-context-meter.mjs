#!/usr/bin/env node
// Тест замера контекста и порога передачи. Смысл проверок: цифра должна браться
// из фактического usage последнего хода основной нити (а не субагента), молчать
// до порога 75%, сработать один раз за сессию и больше не повторяться — даже
// если окно растёт дальше. Файлов передача не создаёт, `/clear` не зовёт.

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

// --- уровни для цвета индикатора: жёлтый с 60%, красный с 75%
check('59% — молчит', level(59), null);
check('60% — warn (жёлтый)', level(60), 'warn');
check('74% — всё ещё warn', level(74), 'warn');
check('75% — act (красный)', level(75), 'act');

// --- ниже порога хук молчит, даже в жёлтой зоне: текст завязан только на 75%
{
  const file = transcript('quiet', [assistant(pctTokens(40))]);
  check('40%: уведомления нет', contextNotice({ transcript_path: file, session_id: 's-quiet' }), null);
  check('40%: хук молчит', runHook({ transcript_path: file, session_id: 's-quiet' }), null);
}
{
  const file = transcript('amber', [assistant(pctTokens(68))]);
  check('68%: уведомления нет', contextNotice({ transcript_path: file, session_id: 's-amber' }), null);
}

// --- порог: одно срабатывание на сессию, текст про блок в чат, без /clear
{
  const file = transcript('act', [assistant(pctTokens(76))]);
  const first = contextNotice({ transcript_path: file, session_id: 's-act' });
  check('76%: сработало', first.pct, 76);
  check('76%: процент в тексте', /76%/.test(first.text), true);
  check('76%: назван скилл handoff', /handoff/.test(first.text), true);
  check('76%: сказано выдать в чат', /чат/.test(first.text), true);
  check('76%: про /clear не просит', /\/clear/.test(first.text), false);
  check('76%: назван resume с id сессии', /--resume s-act/.test(first.text), true);
  check('76%: сначала коммит', /коммит/.test(first.text), true);

  check('повтор на том же проценте молчит', contextNotice({ transcript_path: file, session_id: 's-act' }), null);

  const grown = transcript('act2', [assistant(pctTokens(90))]);
  check('окно выросло до 90% — всё равно молчим', contextNotice({ transcript_path: grown, session_id: 's-act' }), null);
}

// --- сессии не делят состояние объявлений: каждая слышит свой единственный раз
{
  const file = transcript('two', [assistant(pctTokens(80))]);
  check('первая сессия слышит', contextNotice({ transcript_path: file, session_id: 's-a' }).pct, 80);
  check('вторая сессия тоже слышит', contextNotice({ transcript_path: file, session_id: 's-b' }).pct, 80);
  check('первая второй раз — молчит', contextNotice({ transcript_path: file, session_id: 's-a' }), null);
}

// --- хук: доносит текст и не падает на мусоре
{
  const file = transcript('hook', [assistant(pctTokens(88))]);
  check('хук отдаёт текст', /88%/.test(runHook({ transcript_path: file, session_id: 's-hook' })), true);
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
