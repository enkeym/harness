#!/usr/bin/env node
// Тесты диспетчера (claude/dispatch.mjs): один процесс на событие отдаёт тот
// же ответ, что параллельные хуки. deny побеждает ask и правку входа; ask
// несёт updatedInput; шумная команда — только updatedInput; журнал пишет имя
// проверки; падение одной проверки не теряет вердикт другой.

import './env-isolate.mjs';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const DISPATCH = path.join(ROOT, 'claude', 'dispatch.mjs');
const ASK_MODE = path.join(ROOT, 'bin', 'ask-mode.mjs');

let failed = 0;
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  process.stdout.write(`${ok ? 'ok  ' : 'FAIL'} ${name} (got=${JSON.stringify(got)}, want=${JSON.stringify(want)})\n`);
  if (!ok) failed++;
}

// Каждый сценарий — свой каталог проекта, состояние и журналы.
function sandbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-'));
  const cwd = path.join(dir, 'proj');
  fs.mkdirSync(path.join(cwd, '.git'), { recursive: true });
  const env = {
    AI_HOOKS_STATE_DIR: path.join(dir, 'state'),
    AI_HOOKS_LOG_DIR: path.join(dir, 'logs'),
    AI_HOOKS_HOOKS_LOG: path.join(dir, 'logs', 'hooks.jsonl'),
  };
  return { dir, cwd, env };
}

function askOn(sb, sid) {
  spawnSync('node', [ASK_MODE, 'on'], {
    cwd: sb.cwd, encoding: 'utf8', env: { ...process.env, ...sb.env, CLAUDE_CODE_SESSION_ID: sid },
  });
}

function run(sb, event, input) {
  const res = spawnSync('node', [DISPATCH, event], {
    input: JSON.stringify({ cwd: sb.cwd, hook_event_name: event, ...input }),
    encoding: 'utf8',
    env: { ...process.env, ...sb.env },
  });
  return res.stdout ? JSON.parse(res.stdout) : null;
}

const bash = (sb, command, sid = 'sid-d') => run(sb, 'PreToolUse', {
  session_id: sid, tool_name: 'Bash', tool_input: { command },
});

function records(sb) {
  try {
    return fs.readFileSync(sb.env.AI_HOOKS_HOOKS_LOG, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}

// --- deny побеждает ask: причины всех запретивших, без текста ask ---
{
  const sb = sandbox();
  askOn(sb, 'sid-d');
  const out = bash(sb, 'git commit -m x')?.hookSpecificOutput || {};
  check('commit в ask mode: deny', out.permissionDecision, 'deny');
  const reasons = String(out.permissionDecisionReason).split('\n');
  check('причины ask-guard и skill-gate по порядку таблицы',
    [reasons.length, reasons[0].startsWith('Запрещено в ask mode'), reasons[1].startsWith('Коммит без ревью')],
    [2, true, true]);
  check('текст ask гарда безопасности отброшен', out.permissionDecisionReason.includes('security-guard'), false);
  check('журнал: имена проверок, не dispatch',
    records(sb).map((r) => [r.hook, r.decision]),
    [['ask-guard', 'deny'], ['security-guard', 'ask'], ['skill-gate', 'deny']]);
}

// --- deny побеждает правку входа ---
{
  const sb = sandbox();
  askOn(sb, 'sid-d');
  const out = bash(sb, 'npm install')?.hookSpecificOutput || {};
  check('npm install в ask mode: deny', out.permissionDecision, 'deny');
  check('npm install в ask mode: без updatedInput', out.updatedInput, undefined);
}

// --- ask несёт исправленный вход ---
{
  const out = bash(sandbox(), 'docker compose config')?.hookSpecificOutput || {};
  check('docker compose config: ask', out.permissionDecision, 'ask');
  check('docker compose config: команда через ограничитель', /clip-output\.sh docker compose -- /.test(out.updatedInput?.command), true);
}

// --- шумная команда: только updatedInput ---
{
  const sb = sandbox();
  const out = bash(sb, 'npm test')?.hookSpecificOutput || {};
  check('npm test: без решения', out.permissionDecision, undefined);
  check('npm test: через ограничитель', /clip-output\.sh npm test -- 'npm test'$/.test(out.updatedInput?.command), true);
  check('npm test: журнал пуст', records(sb).length, 0);
}

// --- обычный вызов: молчание ---
{
  const sb = sandbox();
  check('ls: пустой ответ', bash(sb, 'ls'), null);
}

// --- падение одной проверки не теряет вердикт другой ---
{
  // Каталог состояния — файл: scratch падает на записи списка черновиков.
  const sb = sandbox();
  fs.writeFileSync(sb.env.AI_HOOKS_STATE_DIR, '');
  const out = bash(sb, `git commit -m x > ${path.join(sb.dir, 'new.log')}`)?.hookSpecificOutput || {};
  check('scratch упал, skill-gate запретил', out.permissionDecision, 'deny');
  check('падение записано под именем проверки',
    records(sb).filter((r) => r.decision === 'crash').map((r) => r.hook), ['scratch']);
}

// --- PostToolUse: событие в ответе своё ---
{
  const sb = sandbox();
  check('PostToolUse без порога и карты: молчание',
    run(sb, 'PostToolUse', { session_id: 'sid-d', tool_name: 'Edit', tool_input: { file_path: path.join(sb.cwd, 'a.ts') } }),
    null);
}

// --- регистрация: наши хуки события — один вызов диспетчера ---
{
  const settings = JSON.parse(fs.readFileSync(path.join(ROOT, '..', 'claude', 'settings.json'), 'utf8'));
  for (const event of ['PreToolUse', 'PostToolUse']) {
    const ours = settings.hooks[event].flatMap((g) => g.hooks).map((h) => h.command).filter((c) => c.includes('.ai-hooks'));
    check(`settings.json ${event}: только диспетчер`, ours, [`node "$HOME/.ai-hooks/claude/dispatch.mjs" ${event}`]);
  }
}

process.stdout.write(failed ? `\n=== ${failed} проверок упало ===\n` : '\n=== все проверки прошли ===\n');
process.exit(failed ? 1 : 0);
