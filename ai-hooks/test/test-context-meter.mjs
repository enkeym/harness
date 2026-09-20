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
const STEP_HOOK = path.join(ROOT, 'claude', 'context-step.mjs');

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
  AI_HOOKS_CTX_STEP_REPEAT: '20000',
};
Object.assign(process.env, ENV);
const { contextUsed, contextNotice, noteWork, level, WINDOW, SOFT, HAND, HARD, STEP_REPEAT } = await import('../context-core.mjs');

// В сессии появилась работа: без неё текст порога другой — передавать нечего.
const work = (sessionId) => noteWork({ session_id: sessionId, tool_name: 'Edit', tool_input: {} });

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

function runStepHook(input) {
  const out = execFileSync('node', [STEP_HOOK], {
    input: JSON.stringify(input),
    encoding: 'utf8',
    env: { ...process.env, ...ENV },
  });
  return out.trim() ? JSON.parse(out).hookSpecificOutput : null;
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
  work('s-soft');
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
  work('s-esc');

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

// --- посреди хода: первый порог закрывает шаг, но блока ещё не просит
{
  const file = transcript('step-soft', [assistant(95_000)]);
  work('s-step-soft');
  const n = contextNotice({ transcript_path: file, session_id: 's-step-soft' }, { phase: 'step' });
  check('95k посреди хода: soft', n.stage, 'soft');
  check('95k посреди хода: ответ не обрывать', /не обрывай/.test(n.text), true);
  check('95k посреди хода: про handoff пока не просит', /handoff/.test(n.text), false);
}

// --- посреди хода на втором пороге: довести шаг до коммита с пушем, и только
// потом блок передачи — а не обрыв ответа на половине
{
  const file = transcript('step-hand', [assistant(160_000)]);
  work('s-step');
  const input = { transcript_path: file, session_id: 's-step' };
  const n = contextNotice(input, { phase: 'step' });
  check('160k посреди хода: hand', n.stage, 'hand');
  check('160k посреди хода: ответ не обрывать', /не обрывай/.test(n.text), true);
  check('160k посреди хода: коммит и пуш', /коммитом и пушем/.test(n.text), true);
  check('160k посреди хода: назван скилл handoff', /handoff/.test(n.text), true);
  check('160k посреди хода: следующий шаг — новой сессии',
    /Следующий шаг здесь не начинай/.test(n.text), true);
  check('тот же порог посреди хода второй раз молчит',
    contextNotice(input, { phase: 'step' }), null);
  check('и на следующем промпте не повторяется', contextNotice(input), null);
}

// --- верхний порог посреди хода повторяется по росту контекста, а не на каждом
// вызове: вызовов в автономном ходе сотни
{
  const sid = 's-step-hard';
  const first = transcript('step-hard-1', [assistant(240_000)]);
  const small = transcript('step-hard-2', [assistant(240_000 + STEP_REPEAT - 5_000)]);
  const grown = transcript('step-hard-3', [assistant(240_000 + STEP_REPEAT + 2_000)]);

  check('240k посреди хода: hard',
    contextNotice({ transcript_path: first, session_id: sid }, { phase: 'step' }).stage, 'hard');
  check('рост меньше STEP_REPEAT: повтора нет',
    contextNotice({ transcript_path: small, session_id: sid }, { phase: 'step' }), null);
  check('рост больше STEP_REPEAT: повтор звучит',
    contextNotice({ transcript_path: grown, session_id: sid }, { phase: 'step' }).stage, 'hard');
  check('на ходу пользователя hard повторяется без условия роста',
    contextNotice({ transcript_path: grown, session_id: sid }).stage, 'hard');
}

// --- step-хук: доносит текст со своим событием и не падает на мусоре
{
  const file = transcript('step-hook', [assistant(240_000)]);
  const out = runStepHook({ transcript_path: file, session_id: 's-step-hook' });
  check('step-хук отдаёт текст', /240k/.test(out.additionalContext), true);
  check('step-хук называет своё событие', out.hookEventName, 'PostToolUse');
  const quiet = transcript('step-quiet', [assistant(40_000)]);
  check('ниже порога: step-хук молчит',
    runStepHook({ transcript_path: quiet, session_id: 's-step-quiet' }), null);
  const broken = execFileSync('node', [STEP_HOOK], {
    input: 'не json',
    encoding: 'utf8',
    env: { ...process.env, ...ENV },
  });
  check('step-хук, битый ввод: пустой ответ', broken.trim(), '');
}

// --- сессия, где первый порог съеден одним сбором данных, не обязана вставать
// до начала работы: передавать ей нечего, и новая сессия упёрлась бы в тот же
// порог — петля. Выше первого порога такая сессия — чаще обсуждение, чем
// подготовка к правке: коммитить ей нечего, а выводы терять нельзя, поэтому блок
// просят, но из выводов, не из списка прочитанного
{
  const soft = transcript('idle-soft', [assistant(95_000)]);
  const hand = transcript('idle-hand', [assistant(160_000)]);
  const hard = transcript('idle-hard', [assistant(240_000)]);
  const sid = 's-idle';

  const first = contextNotice({ transcript_path: soft, session_id: sid }, { phase: 'step' });
  check('без правок: шаг бросать не велят', /шаг не бросай/.test(first.text), true);
  check('без правок: про handoff не просят', /handoff/.test(first.text), false);
  check('без правок: сказано сузить чтение', /Сузь чтение/.test(first.text), true);

  const second = contextNotice({ transcript_path: hand, session_id: sid }, { phase: 'step' });
  check('без правок на 160k: коммит остаётся для сессии, ведущей к правке',
    /закрой его коммитом/.test(second.text), true);
  check('без правок на 160k: блок из выводов по скиллу handoff',
    /выводы[^.]*`handoff`/.test(second.text), true);
  check('без правок на 160k: прочитанное в блок не идёт',
    /Прочитанное в блоке не перечисляй/.test(second.text), true);

  const third = contextNotice({ transcript_path: hard, session_id: sid }, { phase: 'step' });
  check('без правок на 240k: разрешено сказать пользователю',
    /скажи об этом пользователю/.test(third.text), true);
  check('без правок на 240k: блок из выводов тоже просят', /handoff/.test(third.text), true);

  // появилась правка — и требование меняется на передачу
  work(sid);
  const grown = transcript('idle-grown', [assistant(240_000 + STEP_REPEAT + 2_000)]);
  const after = contextNotice({ transcript_path: grown, session_id: sid }, { phase: 'step' });
  check('после первой правки: просят блок передачи', /handoff/.test(after.text), true);
}

// --- отметка работы: чтение ею не считается, правка и коммит — считаются
{
  check('Read работой не считается',
    noteWork({ session_id: 's-work', tool_name: 'Read', tool_input: { file_path: '/a' } }), false);
  check('git status работой не считается',
    noteWork({ session_id: 's-work', tool_name: 'Bash', tool_input: { command: 'git status' } }), false);
  check('git commit считается',
    noteWork({ session_id: 's-work', tool_name: 'Bash', tool_input: { command: 'git commit -m x' } }), true);
  check('повторная отметка файл не трогает',
    noteWork({ session_id: 's-work', tool_name: 'Edit', tool_input: {} }), false);
  check('правка через mcp считается',
    noteWork({ session_id: 's-mcp', tool_name: 'mcp__tokensave__tokensave_str_replace', tool_input: {} }), true);
  check('без id сессии отметки нет',
    noteWork({ tool_name: 'Edit', tool_input: {} }), false);
}

// --- посреди хода без id сессии дедупликации нет — молчим
{
  const file = transcript('no-sid', [assistant(240_000)]);
  check('step без session_id: молчит',
    contextNotice({ transcript_path: file }, { phase: 'step' }), null);
  check('на ходу пользователя без session_id — всё ещё звучит',
    contextNotice({ transcript_path: file }).stage, 'hard');
}

fs.rmSync(tmp, { recursive: true, force: true });
process.stdout.write(failed ? `\n=== ${failed} FAIL ===\n` : '\n=== все проверки прошли ===\n');
process.exit(failed ? 1 : 0);
