#!/usr/bin/env node
// Тесты имён параметров tokensave (tool-args-core.mjs, claude/tool-args.mjs):
// угаданное имя становится настоящим, верный вход не трогается, хук отдаёт
// updatedInput без решения, а гарды видят путь правки и под угаданным именем.

import './env-isolate.mjs';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeToolInput } from '../tool-args-core.mjs';
import { securityGuard } from '../security-core.mjs';
import { GATES } from '../skill-core.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const HOOK = path.join(ROOT, 'claude', 'tool-args.mjs');
const READ = 'mcp__tokensave__tokensave_read';
const EDIT = 'mcp__tokensave__tokensave_str_replace';
const MULTI = 'mcp__tokensave__tokensave_multi_str_replace';

let failed = 0;
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  process.stdout.write(`${ok ? 'ok  ' : 'FAIL'} ${name} (got=${JSON.stringify(got)}, want=${JSON.stringify(want)})\n`);
  if (!ok) failed++;
}

// --- ядро ---
check('read: path → file', normalizeToolInput(READ, { path: 'a.ts', mode: 'lines', lines: '1-5' }),
  { mode: 'lines', lines: '1-5', file: 'a.ts' });
check('read: file_path → file', normalizeToolInput(READ, { file_path: 'a.ts' }), { file: 'a.ts' });
check('read: file и path — остаётся file', normalizeToolInput(READ, { file: 'a.ts', path: 'b.ts' }), { file: 'a.ts' });
check('str_replace: file, old_string, new_string', normalizeToolInput(EDIT, { file: 'a.ts', old_string: 'x', new_string: 'y' }),
  { path: 'a.ts', old_str: 'x', new_str: 'y' });
check('multi: edits объектами → replacements парами',
  normalizeToolInput(MULTI, { file: 'a.ts', edits: [{ old_str: 'x', new_str: 'y' }, { old_string: 'p', new_string: 'q' }, ['m', 'n']] }),
  { path: 'a.ts', replacements: [['x', 'y'], ['p', 'q'], ['m', 'n']] });
{
  const odd = { path: 'a.ts', replacements: [{ old: 'x' }] };
  check('multi: неразборчивый элемент — тот же объект', normalizeToolInput(MULTI, odd) === odd, true);
}
{
  const ok = { path: 'a.ts', replacements: [['x', 'y']] };
  check('верный вход — тот же объект', normalizeToolInput(MULTI, ok) === ok, true);
}
check('чужой инструмент не трогается', normalizeToolInput('mcp__tokensave__tokensave_body', { path: 'a' }), { path: 'a' });
check('пустой вход', normalizeToolInput(READ, undefined), undefined);

// --- хук ---
function run(input) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tool-args-'));
  const env = { AI_HOOKS_STATE_DIR: path.join(dir, 'state'), AI_HOOKS_LOG_DIR: path.join(dir, 'logs'), AI_HOOKS_HOOKS_LOG: path.join(dir, 'logs', 'hooks.jsonl') };
  const res = spawnSync('node', [HOOK], { input: JSON.stringify({ session_id: 's', cwd: '/tmp', ...input }), encoding: 'utf8', env: { ...process.env, ...env } });
  return res.stdout ? JSON.parse(res.stdout).hookSpecificOutput : null;
}
check('хук: исправленный вход без решения', run({ tool_name: READ, tool_input: { path: 'a.ts' } }),
  { hookEventName: 'PreToolUse', updatedInput: { file: 'a.ts' } });
check('хук: верный вход — молчит', run({ tool_name: READ, tool_input: { file: 'a.ts' } }), null);

// --- гарды под угаданным именем ---
check('security-guard: .env правкой по file — запрет',
  securityGuard(EDIT, { file: '.env', old_str: 'a', new_str: 'b' }, { cwd: '/tmp/proj' })?.level, 'deny');
check('skill-gate: SKILL.md правкой по file — гейт',
  GATES[0].matches(EDIT, { file: 'skills/x/SKILL.md', old_str: 'a', new_str: 'b' }, '/home/u/harness'), true);

process.stdout.write(failed ? `\n=== ${failed} проверок упало ===\n` : '\n=== все проверки прошли ===\n');
process.exit(failed ? 1 : 0);
