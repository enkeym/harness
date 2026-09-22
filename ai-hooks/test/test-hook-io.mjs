#!/usr/bin/env node
// Тесты общего ввода/вывода PreToolUse-хуков (claude/hook-io.mjs): битый stdin
// пропускает вызов; respond держит первый отказ, повтор с той же сессией
// пропускает с объяснением, соседнюю цель того же класса — молча; Bash
// предохранителем не спасается; без session_id отказ повторяется; decide
// отдаёт ask/deny и молчит на null.

import './env-isolate.mjs';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const HOOK = path.join(ROOT, 'test', 'fixtures', 'respond-hook.mjs');
const REASON = 'fixture: отказ';

let failed = 0;
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  process.stdout.write(`${ok ? 'ok  ' : 'FAIL'} ${name} (got=${JSON.stringify(got)}, want=${JSON.stringify(want)})\n`);
  if (!ok) failed++;
}

// Каждый сценарий — своё состояние предохранителя и свои журналы.
function sandbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hook-io-'));
  return {
    AI_HOOKS_STATE_DIR: path.join(dir, 'state'),
    AI_HOOKS_LOG_DIR: path.join(dir, 'logs'),
    AI_HOOKS_HOOKS_LOG: path.join(dir, 'logs', 'hooks.jsonl'),
    AI_HOOKS_GUARD_LOG: path.join(dir, 'logs', 'guard.log'),
  };
}

function runRaw(raw, env) {
  return spawnSync('node', [HOOK], { input: raw, encoding: 'utf8', env: { ...process.env, ...env } });
}

// Что хук ответил: 'allow' (пустой stdout), решение или 'message' (systemMessage).
function verdict(res) {
  if (!res.stdout) return 'allow';
  const out = JSON.parse(res.stdout);
  return out.hookSpecificOutput?.permissionDecision || (out.systemMessage ? 'message' : 'unknown');
}

const read = (file, extra = {}) => ({ tool_name: 'Read', cwd: '/tmp', tool_input: { file_path: file }, fixture_reason: REASON, ...extra });

function records(env) {
  try {
    return fs.readFileSync(env.AI_HOOKS_HOOKS_LOG, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}

// --- битый stdin ---
{
  const res = runRaw('{не json', sandbox());
  check('битый stdin: код 0', res.status, 0);
  check('битый stdin: stdout пуст', res.stdout, '');
}

// --- respond без причины ---
{
  const res = runRaw(JSON.stringify(read('/tmp/a.ts', { session_id: 's', fixture_reason: null })), sandbox());
  check('respond(null): разрешено', verdict(res), 'allow');
}

// --- предохранитель: отказ, повтор с объяснением, соседняя цель молча ---
{
  const env = sandbox();
  const call = (file) => runRaw(JSON.stringify(read(file, { session_id: 'sid-br' })), env);

  const first = call('/tmp/a.ts');
  check('первый отказ держится', verdict(first), 'deny');
  check('причина передана', JSON.parse(first.stdout).hookSpecificOutput.permissionDecisionReason, REASON);

  const again = call('/tmp/a.ts');
  check('повтор цели → пропуск с объяснением', verdict(again), 'message');
  check('объяснение называет инструмент', JSON.parse(again.stdout).systemMessage.includes('Read пропущен'), true);

  check('соседняя цель того же класса → пропуск молча', verdict(call('/tmp/b.ts')), 'allow');
  check('в журнале отмечен breaker-open', records(env).some((r) => r.decision === 'breaker-open'), true);

  const edit = runRaw(JSON.stringify({ ...read('/tmp/a.ts', { session_id: 'sid-br' }), tool_name: 'Edit' }), env);
  check('другой класс латчем не задет', verdict(edit), 'deny');
}

// --- без session_id предохранителя нет ---
{
  const env = sandbox();
  const call = () => runRaw(JSON.stringify(read('/tmp/a.ts')), env);
  call();
  check('без session_id повтор снова отказ', verdict(call()), 'deny');
}

// --- Bash предохранителем не спасается ---
{
  const env = sandbox();
  const call = () => runRaw(JSON.stringify({
    session_id: 'sid-bash', tool_name: 'Bash', cwd: '/tmp',
    tool_input: { command: 'cat src/a.ts' }, fixture_reason: REASON,
  }), env);
  check('bash: первый отказ', verdict(call()), 'deny');
  check('bash: повтор тоже отказ', verdict(call()), 'deny');
  check('bash: и третий', verdict(call()), 'deny');
}

// --- decide ---
{
  const env = sandbox();
  const call = (decision) => runRaw(JSON.stringify(read('/tmp/a.ts', {
    session_id: 'sid-dec', fixture_exit: 'decide', fixture_decision: decision,
  })), env);
  check('decide(null): разрешено', verdict(call(null)), 'allow');
  check('decide(null): журнал пуст', records(env).length, 0);
  check('decide(ask): ask', verdict(call('ask')), 'ask');
  check('decide(deny): повтор без предохранителя', [verdict(call('deny')), verdict(call('deny'))], ['deny', 'deny']);
  check('decide: решения в журнале', records(env).map((r) => r.decision), ['ask', 'deny', 'deny']);
}

process.stdout.write(failed ? `\n=== ${failed} проверок упало ===\n` : '\n=== все проверки прошли ===\n');
process.exit(failed ? 1 : 0);
