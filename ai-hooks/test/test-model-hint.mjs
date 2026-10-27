#!/usr/bin/env node
// Тесты подсказки /model opus (model-hint): три провала одной проверки с
// правками между ними на Sonnet → systemMessage и контекст, раз за сессию.
// Повтор без правки, успех, Opus, прерывание и не-проверка серию не дают.

import './env-isolate.mjs';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const DISPATCH = path.join(ROOT, 'claude', 'dispatch.mjs');
const ADAPTER = path.join(ROOT, 'claude', 'model-hint.mjs');

let failed = 0;
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  process.stdout.write(`${ok ? 'ok  ' : 'FAIL'} ${name} (got=${JSON.stringify(got)}, want=${JSON.stringify(want)})\n`);
  if (!ok) failed++;
}

function sandbox(model = 'claude-sonnet-5-5') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'model-hint-'));
  const transcript = path.join(dir, 't.jsonl');
  fs.writeFileSync(transcript, JSON.stringify({
    type: 'assistant', message: { model, usage: { input_tokens: 1000, output_tokens: 10 } },
  }) + '\n');
  const env = {
    AI_HOOKS_STATE_DIR: path.join(dir, 'state'),
    AI_HOOKS_LOG_DIR: path.join(dir, 'logs'),
    AI_HOOKS_HOOKS_LOG: path.join(dir, 'logs', 'hooks.jsonl'),
  };
  return { dir, cwd: dir, transcript, env };
}

function run(sb, event, input, script = DISPATCH) {
  const res = spawnSync('node', script === DISPATCH ? [script, event] : [script], {
    input: JSON.stringify({ cwd: sb.cwd, session_id: 'sid-m', transcript_path: sb.transcript, hook_event_name: event, ...input }),
    encoding: 'utf8',
    env: { ...process.env, ...sb.env },
  });
  return res.stdout ? JSON.parse(res.stdout) : null;
}

const TSC = 'npx tsc --noEmit';
const fail = (sb, command = TSC, extra = {}) => run(sb, 'PostToolUseFailure', {
  tool_name: 'Bash', tool_input: { command }, error: 'Exit code 2\nerror TS2322', ...extra,
});
const pass = (sb, command = TSC) => run(sb, 'PostToolUse', {
  tool_name: 'Bash', tool_input: { command }, tool_response: { stdout: '', stderr: '' },
});
const edit = (sb) => run(sb, 'PostToolUse', {
  tool_name: 'mcp__tokensave__tokensave_str_replace', tool_input: { path: 'src/a.ts' },
});
const series = (sb, command = TSC) => { fail(sb, command); edit(sb); fail(sb, command); edit(sb); return fail(sb, command); };

// --- три провала с правками: подсказка пользователю и модели ---
{
  const sb = sandbox();
  check('первый провал: молчание', fail(sb), null);
  edit(sb);
  check('второй провал: молчание', fail(sb), null);
  edit(sb);
  const out = fail(sb);
  check('третий: systemMessage с /model opus', /\/model opus/.test(out?.systemMessage || ''), true);
  check('третий: контекст модели — меню, не четвёртая попытка',
    [out?.hookSpecificOutput?.hookEventName, /AskUserQuestion/.test(out?.hookSpecificOutput?.additionalContext || '')],
    ['PostToolUseFailure', true]);
  const log = fs.readFileSync(sb.env.AI_HOOKS_HOOKS_LOG, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  check('журнал: hint под именем model-hint', log.map((r) => [r.hook, r.decision]), [['model-hint', 'hint']]);
  edit(sb);
  check('раз за сессию: четвёртый провал молчит', fail(sb), null);
}

// --- повтор без правки между попытками не считается ---
{
  const sb = sandbox();
  fail(sb); fail(sb); fail(sb);
  edit(sb);
  check('три повтора без правок + один с правкой: молчание', fail(sb), null);
  edit(sb);
  check('третья настоящая попытка: подсказка', Boolean(fail(sb)?.systemMessage), true);
}

// --- успех проверки обнуляет серию ---
{
  const sb = sandbox();
  fail(sb); edit(sb); fail(sb); edit(sb);
  pass(sb);
  check('после успеха серия заново', fail(sb), null);
}

// --- разные проверки считаются порознь ---
{
  const sb = sandbox();
  fail(sb); edit(sb);
  fail(sb, 'npm test'); edit(sb);
  check('tsc и npm test вперемешку: молчание', fail(sb), null);
}

// --- не Sonnet, прерывание, не проверка: молчание ---
{
  check('Opus: молчание', series(sandbox('claude-opus-5-5')), null);
  const sb = sandbox();
  fail(sb); edit(sb); fail(sb); edit(sb);
  check('прерывание не считается', fail(sb, TSC, { is_interrupt: true }), null);
  check('grep с ненулевым выходом — не проверка', series(sandbox(), 'grep -rn foo --include=*.ts src'), null);
  check('тест харнеса — проверка', Boolean(series(sandbox(), 'node ai-hooks/test/test-dispatch.mjs')?.systemMessage), true);
}

// --- адаптер сам по себе: событие берёт из входа ---
{
  const sb = sandbox();
  const one = () => run(sb, 'PostToolUseFailure', { tool_name: 'Bash', tool_input: { command: TSC } }, ADAPTER);
  const ed = () => run(sb, 'PostToolUse', { tool_name: 'Edit', tool_input: { file_path: 'a.ts' } }, ADAPTER);
  one(); ed(); one(); ed();
  check('адаптер: событие из входа', one()?.hookSpecificOutput?.hookEventName, 'PostToolUseFailure');
}

process.stdout.write(failed ? `\n=== ${failed} проверок упало ===\n` : '\n=== все проверки прошли ===\n');
process.exit(failed ? 1 : 0);
