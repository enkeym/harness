#!/usr/bin/env node
// Тесты общего ввода/вывода PreToolUse-хуков (claude/hook-io.mjs): битый stdin
// пропускает вызов; respond отдаёт deny с причиной и повторяет его на повтор;
// decide отдаёт ask/deny и молчит на null; решения попадают в журнал.

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

// Каждый сценарий — свои журналы.
function sandbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hook-io-'));
  return {
    AI_HOOKS_STATE_DIR: path.join(dir, 'state'),
    AI_HOOKS_LOG_DIR: path.join(dir, 'logs'),
    AI_HOOKS_HOOKS_LOG: path.join(dir, 'logs', 'hooks.jsonl'),
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

// --- respond с причиной: отказ, и повтор — тот же отказ ---
{
  const env = sandbox();
  const call = () => runRaw(JSON.stringify({
    session_id: 'sid-bash', tool_name: 'Bash', cwd: '/tmp',
    tool_input: { command: 'cat src/a.ts' }, fixture_reason: REASON,
  }), env);
  const first = call();
  check('первый отказ', verdict(first), 'deny');
  check('причина передана', JSON.parse(first.stdout).hookSpecificOutput.permissionDecisionReason, REASON);
  check('повтор тоже отказ', verdict(call()), 'deny');
  check('в журнале обе записи с целью', records(env).map((r) => [r.decision, r.target]),
    [['deny', 'cat src/a.ts'], ['deny', 'cat src/a.ts']]);
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
  check('decide(deny): deny и на повтор', [verdict(call('deny')), verdict(call('deny'))], ['deny', 'deny']);
  check('decide: решения в журнале', records(env).map((r) => r.decision), ['ask', 'deny', 'deny']);
}

process.stdout.write(failed ? `\n=== ${failed} проверок упало ===\n` : '\n=== все проверки прошли ===\n');
process.exit(failed ? 1 : 0);
