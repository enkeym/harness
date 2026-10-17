#!/usr/bin/env node
// Тесты доли инструментов (bin/tool-share.mjs): граница делит сессии на «до» и
// «после»; неверная граница или размер — использование и код 1, а не молча
// весь отчёт по одну сторону границы; запись <synthetic> (без вызова API) не
// ответ — не в turns и не в модель; сессии из самого HOME подписаны ~; ответ,
// разбитый на записи с одним message.id, — один ход; отказ без «hook error», но с
// toolDenialKind permission-rule — deny; asks — реплики с ответом API, batch% —
// ответы с несколькими инструментами. --waste: каждый класс потерь с ценой по
// сегменту, правка сбрасывает повторное чтение, отказ пользователя и сбой Bash —
// не ошибка, сессии до границы не в счёте, недостающие вызовы,
// пропущенный rag_search после пустого tokensave_search.

import './env-isolate.mjs';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SCRIPT = path.join(ROOT, 'bin', 'tool-share.mjs');

let failed = 0;
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  process.stdout.write(`${ok ? 'ok  ' : 'FAIL'} ${name} (got=${JSON.stringify(got)}, want=${JSON.stringify(want)})\n`);
  if (!ok) failed++;
}

// Транскрипты лежат под HOME/.claude/projects — скрипт видит только песочницу.
const homes = [];
function sandbox() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tool-share-'));
  const homeDir = path.join(home, '.claude', 'projects', home.replace(/[^a-zA-Z0-9]/g, '-'));
  fs.mkdirSync(`${homeDir}-demo`, { recursive: true });
  fs.mkdirSync(homeDir, { recursive: true });
  homes.push(home);
  return { home, homeDir, projDir: `${homeDir}-demo` };
}
const { home, homeDir, projDir } = sandbox();

const assistant = (timestamp) => ({
  type: 'assistant', timestamp,
  message: { model: 'claude-opus-5', usage: { input_tokens: 1000 }, content: [{ type: 'tool_use', name: 'Read', input: {} }] },
});
const synthetic = (timestamp) => ({
  type: 'assistant', timestamp,
  message: { model: '<synthetic>', usage: { input_tokens: 0 }, content: [{ type: 'text', text: 'No response requested.' }] },
});
const write = (dir, name, recs) => fs.writeFileSync(path.join(dir, name), `${recs.map((r) => JSON.stringify(r)).join('\n')}\n`);
write(projDir, 'aaaaaaaa-1.jsonl', [synthetic('2026-09-01T09:59:00.000Z'), assistant('2026-09-01T10:00:00.000Z')]);
write(projDir, 'bbbbbbbb-2.jsonl', [assistant('2026-09-30T10:00:00.000Z')]);
write(homeDir, 'cccccccc-3.jsonl', [assistant('2026-09-30T11:00:00.000Z')]);

const runIn = (dir, ...args) => spawnSync('node', [SCRIPT, ...args], { encoding: 'utf8', env: { ...process.env, HOME: dir } });
const run = (...args) => runIn(home, ...args);
// Строки итога «всего до» / «всего после» → число сессий в каждой.
const totals = (out) => Object.fromEntries(out.split('\n').filter((l) => l.startsWith('всего '))
  .map((l) => l.split('\t')).map(([label, n]) => [label, n]));

// Строки сессий: шапка до пустой строки → объекты по колонкам.
const rows = (out) => {
  const [head, ...lines] = out.split('\n\n')[0].trim().split('\n').map((l) => l.split('\t'));
  return lines.map((r) => Object.fromEntries(head.map((h, i) => [h, r[i]])));
};

// --- <synthetic> ---
{
  const [first] = rows(run('2026-09-15', '0').stdout);
  check('<synthetic> не в turns и не в модели', [first.file, first.turns, first.model], ['aaaaaaaa', '1', 'opus-5']);
}

// --- один ответ в нескольких записях, отказ без «hook error» ---
{
  const box = sandbox();
  const part = (block) => ({
    type: 'assistant', timestamp: '2026-09-30T10:00:00.000Z',
    message: { id: 'msg_1', model: 'claude-opus-5', usage: { input_tokens: 1000, output_tokens: 10 }, content: [block] },
  });
  write(box.projDir, 'dddddddd-4.jsonl', [
    part({ type: 'text', text: 'читаю' }),
    part({ type: 'tool_use', id: 'toolu_1', name: 'Read', input: {} }),
    { type: 'user', toolDenialKind: 'permission-rule', message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_1', is_error: true, content: 'Файл в индексе tokensave.' }] } },
  ]);
  const [r] = rows(runIn(box.home, '2026-09-15', '0').stdout);
  check('один message.id — один ход, ctx и out один раз', [r.turns, r.ctx, r.out, r.read], ['1', '1k', '0k', '1']);
  check('toolDenialKind permission-rule — deny', r.deny, '1');
}

// --- шаги на реплику и доля пачек ---
{
  const box = sandbox();
  const at = '2026-09-30T10:00:00.000Z';
  const answer = (id, block) => ({
    type: 'assistant', timestamp: at,
    message: { id, model: 'claude-opus-5', usage: { input_tokens: 1000 }, content: [block] },
  });
  const use = (id) => ({ type: 'tool_use', id, name: 'Read', input: {} });
  const prompt = (content) => ({ type: 'user', timestamp: at, message: { content } });
  const result = (id) => ({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content: 'x' }] } });
  write(box.projDir, 'ffffffff-6.jsonl', [
    prompt('почини'),
    answer('m1', use('t1')),
    answer('m1', use('t2')),
    result('t1'),
    result('t2'),
    answer('m2', use('t3')),
    result('t3'),
    answer('m3', { type: 'text', text: 'готово' }),
    prompt('<command-name>/model</command-name>'),
    prompt('<local-command-stdout>Set model</local-command-stdout>'),
    { type: 'user', isMeta: true, message: { content: 'caveat' } },
    prompt([{ type: 'text', text: 'ещё' }]),
    answer('m4', { type: 'text', text: 'да' }),
  ]);
  const [r] = rows(runIn(box.home, '2026-09-15', '0').stdout);
  check('реплика без ответа API не в asks, tool_result не реплика', [r.turns, r.asks, r['steps/ask']], ['4', '2', '2.0']);
  check('batch% — ответы с двумя инструментами среди ответов с инструментами', r['batch%'], '50');
}

// --- --waste ---
{
  const box = sandbox();
  const at = '2026-09-30T10:00:00.000Z';
  const call = (id, win, ...blocks) => ({
    type: 'assistant', timestamp: at, cwd: '/p',
    message: { id, model: 'claude-opus-5', usage: { input_tokens: win, output_tokens: 0 }, content: blocks },
  });
  const use = (id, name, input = {}) => ({ type: 'tool_use', id, name, input });
  const result = (id, chars, { error = false, kind, content = 'x'.repeat(chars) } = {}) => ({
    type: 'user', cwd: '/p', ...(kind && { toolDenialKind: kind }),
    message: { content: [{ type: 'tool_result', tool_use_id: id, is_error: error, content }] },
  });
  const refs = (...names) => ({ content: names.map((tool_name) => ({ type: 'tool_reference', tool_name })) });
  const meta = (content, sourceToolUseID) => ({ type: 'user', isMeta: true, sourceToolUseID, message: { content } });
  const hook = (text) => ({ type: 'attachment', attachment: { type: 'hook_additional_context', content: [text.padEnd(400, '.')] } });
  const TS = 'mcp__tokensave__tokensave_';
  write(box.projDir, 'eeeeeeee-5.jsonl', [
    call('c0', 1000, use('u1', 'Read', { file_path: '/p/a.ts' })),
    result('u1', 10, { error: true, kind: 'permission-rule' }),
    call('c1', 1000, use('u2', 'Read', { file_path: '/p/a.ts' })),
    result('u2', 400),
    call('c2', 1000, use('u3', 'Read', { file_path: '/p/a.ts' }), use('u4', `${TS}nope`)),
    result('u3', 400),
    result('u4', 20, { error: true }),
    call('c3', 1000, use('u5', 'Edit', { file_path: '/p/a.ts' }), use('u6', 'Read', { file_path: '/p/a.ts' }), use('u17', 'Write', { file_path: '/p/c.ts' })),
    result('u5', 10),
    result('u6', 400),
    result('u17', 10, { error: true, kind: 'user-rejected' }),
    call('c4', 1000, use('u7', 'Bash', { command: 'npm test' }), use('u8', 'ToolSearch', { query: 'select:A' }), use('u18', 'Bash', { command: 'false' })),
    result('u7', 24_000),
    result('u8', 0, refs('A')),
    result('u18', 40, { error: true }),
    call('c5', 1000, use('u9', 'ToolSearch', { query: 'select:A,B' }), use('u10', `${TS}read`, { file: 'b.mjs' })),
    result('u9', 0, refs('A', 'B')),
    result('u10', 12_000),
    call('c6', 1000, use('u11', 'Skill', { skill: 'review' }), use('u19', `${TS}search`, { query: 'x' })),
    result('u11', 20),
    meta([{ type: 'text', text: 'x'.repeat(400) }], 'u11'),
    result('u19', 10_000),
    call('c7', 1000, use('u12', 'Skill', { skill: 'review' })),
    result('u12', 20),
    meta([{ type: 'text', text: 'x'.repeat(400) }], 'u12'),
    hook('context-meter: 91k токенов.'),
    hook('Карта неявных связей `docs/links/x.md`'),
    hook('Implicit-links map `docs/links/x.md`, items naming `src/a.ts`'),
    hook('`src/b.ts` is covered by the implicit-links map `docs/links/x.md`'),
    call('c8', 1000, { type: 'text', text: 'готово' }),
    meta('Stop hook feedback:\nХод кончился без меню.'),
    call('c9', 200_000, use('u13', 'Skill', { skill: 'handoff' })),
    call('c10', 210_000, { type: 'text', text: 'план' }),
    call('c11', 1000, use('u14', `${TS}read`, { file: 'b.mjs' })),
    result('u14', 12_000),
    call('c12', 1000, use('u15', `${TS}read`, { file: '/p/b.mjs' }), use('u16', `${TS}read`, { file: 'b.mjs', if_digest: 'd' }), use('u20', `${TS}context`, { task: 'x' })),
    result('u15', 12_000),
    result('u16', 40),
    result('u20', 400),
    call('c13', 1000, { type: 'text', text: 'конец' }),
  ]);
  write(box.projDir, 'ffffffff-6.jsonl', [
    { ...call('o0', 1000, use('o1', 'Read', { file_path: '/p/a.ts' })), timestamp: '2026-09-01T10:00:00.000Z' },
    result('o1', 10, { error: true, kind: 'permission-rule' }),
    { ...call('o2', 1000), timestamp: '2026-09-01T10:01:00.000Z' },
  ]);
  const out = runIn(box.home, '--waste', '2026-09-15', '0').stdout;
  const [summary, classTable, topTable, missingTable] = out.trim().split('\n\n');
  const table = (block) => {
    const [head, ...lines] = block.split('\n').map((l) => l.split('\t'));
    return Object.fromEntries(lines.map((r) => [r[0], Object.fromEntries(head.map((h, i) => [h, r[i]]))]));
  };
  const classes = table(classTable);
  const got = (cls) => [classes[cls]?.['случаи'], classes[cls]?.['ток.']];

  check('--waste: только сессии после границы', summary.split(',')[0], 'сессий 1');
  check('deny — следующий вызов целиком, повтор той же цели в примечании',
    [...got('deny'), classes.deny?.['примечание']], ['1', '1.0k', 'повтор той же цели: 1']);
  check('error — без отказа пользователя и сбоя Bash', got('error'), ['1', '1.0k']);
  check('stop — следующий вызов целиком, $ по его usage', [...got('stop'), classes.stop?.$], ['1', '200.0k', '1.00']);
  check('reread — правка сбрасывает, if_digest не в счёте, новый сегмент с нуля', got('reread'), ['2', '3.8k']);
  check('fullread — файл кода целиком без правки, цена по остатку сегмента', got('fullread'), ['2', '21.0k']);
  check('bigbash — только сверх 5k', got('bigbash'), ['1', '6.0k']);
  check('toolsearch — повтор уже загруженной схемы, только случай', got('toolsearch'), ['1', '0.0k']);
  check('skill — повторный текст скилла', got('skill'), ['1', '0.3k']);
  check('meter и links — тексты хуков, links в трёх формах', [got('meter'), got('links')], [['1', '0.3k'], ['3', '0.9k']]);
  check('handoff — сверх 150k до Skill handoff', got('handoff'), ['1', '50.0k']);
  check('топ сессий — без сессии до границы', Object.keys(table(topTable)), ['-demo']);
  const missing = table(missingTable);
  check('недостающие вызовы', [missing['read без if_digest']?.['ток.'], missing['search без path_include']?.['ток.'], missing.tokensave_context?.['случаи']],
    ['3.0k', '2.5k', '1']);
  check('без пустого search пропущенного rag нет', missing['rag_search после пустого search']?.['случаи'], '0');

  // Пропущенный rag: цепочка grep после пустого поиска по имени — один случай;
  // rag_search сбрасывает; после пустого literal grep по коду в правилах, по докам — нет;
  // после непустого search grep не в счёте, grep-фильтр после `|`
  // и grep по /tmp/ — не поиск по проекту. Там же rag_search точной строки без path_include.
  const ragBox = sandbox();
  const empty = { content: [{ type: 'text', text: 'count: 0\n\n' }] };
  write(ragBox.projDir, 'gggggggg-7.jsonl', [
    call('r0', 1000, use('g1', `${TS}search`, { query: 'retryPolicy' })),
    result('g1', 0, empty),
    call('r1', 1000, use('g2', 'Bash', { command: 'grep -rn retry src' })),
    result('g2', 4000),
    call('r2', 1000, use('g3', 'Grep', { pattern: 'retry' }), use('g4', 'mcp__ragsave__rag_search', { query: 'retry' })),
    result('g3', 4000),
    result('g4', 400),
    call('r3', 1000, use('g5', 'Bash', { command: 'grep -rn retry lib' })),
    result('g5', 400),
    call('r4', 1000, use('g6', `${TS}search`, { query: 'RETRY_MAX', literal: true })),
    result('g6', 0, empty),
    call('r5', 1000, use('g7', 'Bash', { command: 'grep -rn RETRY_MAX --include=*.ts src' })),
    result('g7', 400),
    call('r6', 1000, use('g8', 'Bash', { command: 'grep -rn RETRY_MAX docs/setup.md' })),
    result('g8', 4000),
    call('r7', 1000, use('g9', `${TS}search`, { query: 'retry' })),
    result('g9', 400),
    call('r8', 1000, use('g10', 'Grep', { pattern: 'retry', glob: '*.yml' })),
    result('g10', 400),
    call('r10', 1000, use('g11', `${TS}search`, { query: 'retryLimit' })),
    result('g11', 0, empty),
    call('r11', 1000, use('g12', 'Bash', { command: 'node t.mjs | grep FAIL' })),
    result('g12', 4000),
    call('r12', 1000, use('g13', 'Bash', { command: 'grep -c FAIL /tmp/t.out' })),
    result('g13', 4000),
    call('r13', 1000, use('g14', 'mcp__ragsave__rag_search', { query: 'retryPolicy' }),
      use('g15', 'mcp__ragsave__rag_search', { query: 'RETRY_MAX', path_include: ['docs'] }),
      use('g16', 'mcp__ragsave__rag_search', { query: 'retry policy' })),
    result('g14', 400),
    result('g15', 400),
    result('g16', 400),
    call('r9', 1000, { type: 'text', text: 'конец' }),
  ]);
  const ragOut = runIn(ragBox.home, '--waste', '2026-09-15', '0').stdout;
  const noRag = table(ragOut.trim().split('\n\n')[3])['rag_search после пустого search'];
  check('пропущенный rag — цепочки grep после пустого search, literal — только доки',
    [noRag?.['случаи'], noRag?.['сессии'], noRag?.['ток.']], ['2', '1', '3.0k']);
  const ragExact = table(ragOut.trim().split('\n\n')[3])['rag_search строки без path_include'];
  check('rag_search точной строки без path_include — с фильтром и фраза не в счёте',
    [ragExact?.['случаи'], ragExact?.['сессии']], ['1', '1']);

  const bad = runIn(box.home, '--waste', 'yesterday');
  check('--waste с неверной границей — использование, код 1', [bad.status, bad.stderr.startsWith('Запуск:')], [1, true]);
}

// --- проект ---
check('сам каталог HOME — ~, префикс HOME срезан', rows(run('2026-09-15', '0').stdout).map((r) => r.proj), ['-demo', '-demo', '~']);

// --- граница ---
check('граница делит сессии', totals(run('2026-09-15', '0').stdout), { 'всего до': '1 сессий', 'всего после': '2 сессий' });
check('граница со временем в Z', totals(run('2026-09-30T12:00:00Z', '0').stdout), { 'всего до': '3 сессий' });

// --- аргументы ---
const help = run('--help');
check('--help — использование, код 0', [help.status, help.stdout.startsWith('Запуск:')], [0, true]);
for (const args of [['yesterday'], ['2026-09-15T10:00:00+03:00'], ['2026-13-45'], ['2026-09-15', 'abc']]) {
  const r = run(...args);
  check(`${args.join(' ')} — использование в stderr, код 1`, [r.status, r.stdout, r.stderr.startsWith('Запуск:')], [1, '', true]);
}

for (const dir of homes) fs.rmSync(dir, { recursive: true, force: true });
process.stdout.write(failed ? `\n=== ${failed} проверок упало ===\n` : '\n=== все проверки прошли ===\n');
process.exit(failed ? 1 : 0);
