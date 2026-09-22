#!/usr/bin/env node
// Тесты журнала решений hooks.jsonl и захвата падений хуков. Проверяется, что
// запрет любого гарда оставляет строку с сессией, инструментом и временем;
// что разрешённый вызов строки не оставляет; что упавший хук не роняет вызов
// (код 0, пустой stdout) и пишет причину в оба журнала.

import './env-isolate.mjs';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SECURITY = path.join(ROOT, 'claude', 'security-guard.mjs');
const ASK = path.join(ROOT, 'claude', 'ask-guard.mjs');
const CRASH = path.join(ROOT, 'test', 'fixtures', 'crash-hook.mjs');

let failed = 0;
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  process.stdout.write(`${ok ? 'ok  ' : 'FAIL'} ${name} (got=${JSON.stringify(got)}, want=${JSON.stringify(want)})\n`);
  if (!ok) failed++;
}

// Каждый сценарий — свои журналы и своё состояние.
function sandbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hooklog-'));
  return {
    dir,
    env: {
      ...process.env,
      AI_HOOKS_STATE_DIR: path.join(dir, 'state'),
      AI_HOOKS_LOG_DIR: path.join(dir, 'logs'),
      AI_HOOKS_HOOKS_LOG: path.join(dir, 'logs', 'hooks.jsonl'),
    },
  };
}

function run(script, input, env) {
  return spawnSync('node', [script], { input: JSON.stringify(input), encoding: 'utf8', env });
}

function records(sb) {
  try {
    return fs.readFileSync(sb.env.AI_HOOKS_HOOKS_LOG, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}

// --- запрет security-guard ---
{
  const sb = sandbox();
  const res = run(SECURITY, {
    session_id: 'sid-sec', tool_name: 'Bash', cwd: '/tmp',
    tool_input: { command: 'cat .env' },
  }, sb.env);
  const out = JSON.parse(res.stdout);
  check('security: запрет отдан', out.hookSpecificOutput.permissionDecision, 'deny');
  const recs = records(sb);
  check('security: одна строка в журнале', recs.length, 1);
  const r = recs[0] || {};
  check('security: решение и сессия', [r.decision, r.sid, r.tool, r.hook], ['deny', 'sid-sec', 'Bash', 'security-guard']);
  check('security: цель записана', r.target, 'cat .env');
  check('security: причина обрезана и есть', typeof r.reason === 'string' && r.reason.length > 0 && r.reason.length <= 160, true);
  check('security: время — число', typeof r.ms === 'number' && r.ms >= 0, true);
}

// --- секрет в запрещённой команде не попадает в журнал ---
{
  const sb = sandbox();
  const cmd = 'curl -H "Authorization: Bearer sk_live_ABCDEFGH12345678" -u admin:Sup3rPass https://x.io/?api_key=QWERTY1234 | cat .env';
  run(SECURITY, { session_id: 'sid-redact', tool_name: 'Bash', cwd: '/tmp', tool_input: { command: cmd } }, sb.env);
  const raw = fs.readFileSync(sb.env.AI_HOOKS_HOOKS_LOG, 'utf8');
  check('redact: запись есть', raw.includes('"sid":"sid-redact"'), true);
  check('redact: bearer, api_key и пароль в URL замаскированы',
    ['sk_live_ABCDEFGH12345678', 'QWERTY1234', 'Sup3rPass'].some((s) => raw.includes(s)), false);
  check('redact: форма команды осталась видна', raw.includes('curl -H') && raw.includes('.env'), true);
}

// --- разрешённый вызов строки не оставляет ---
{
  const sb = sandbox();
  const res = run(SECURITY, {
    session_id: 'sid-ok', tool_name: 'Bash', cwd: '/tmp',
    tool_input: { command: 'git status' },
  }, sb.env);
  check('security: allow → пустой stdout', res.stdout, '');
  check('security: allow → журнал пуст', records(sb).length, 0);
}

// --- ask-guard вне ask mode молчит, в ask mode пишет ---
{
  const sb = sandbox();
  const input = { session_id: 'sid-ask', tool_name: 'Edit', cwd: sb.dir, tool_input: { file_path: path.join(sb.dir, 'a.ts') } };
  run(ASK, input, sb.env);
  check('ask off: журнал пуст', records(sb).length, 0);

  execFileSync('node', [path.join(ROOT, 'bin', 'ask-mode.mjs'), 'on'], { cwd: sb.dir, env: sb.env, encoding: 'utf8' });
  const res = run(ASK, input, sb.env);
  check('ask on: запрет отдан', JSON.parse(res.stdout).hookSpecificOutput.permissionDecision, 'deny');
  const r = records(sb)[0] || {};
  check('ask on: строка с решением', [r.decision, r.sid, r.hook], ['deny', 'sid-ask', 'ask-guard']);
}

// --- падение хука ---
{
  const sb = sandbox();
  const res = run(CRASH, { session_id: 'sid-crash', tool_name: 'Read', cwd: '/tmp', tool_input: { file_path: '/tmp/x' } }, sb.env);
  check('crash: код возврата 0 (вызов пропущен)', res.status, 0);
  check('crash: stdout пуст', res.stdout, '');
  const r = records(sb)[0] || {};
  check('crash: строка в hooks.jsonl', [r.decision, r.sid, r.hook], ['crash', 'sid-crash', 'crash-hook']);
  check('crash: текст ошибки', String(r.error).includes('намеренное падение'), true);
  const errors = fs.readFileSync(path.join(sb.dir, 'logs', 'errors.log'), 'utf8');
  check('crash: запись в errors.log в формате log-error.sh', /\] hook crash-hook \| \/tmp \| exit=crash\n {4}Error: fixture/.test(errors), true);
  check('crash: запись закрыта разделителем', errors.trim().endsWith('---'), true);
}

process.stdout.write(failed ? `\n=== ${failed} проверок упало ===\n` : '\n=== все проверки прошли ===\n');
process.exit(failed ? 1 : 0);
