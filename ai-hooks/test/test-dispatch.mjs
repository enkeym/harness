#!/usr/bin/env node
// Тесты диспетчера (claude/dispatch.mjs): один процесс на событие отдаёт тот
// же ответ, что параллельные хуки. deny побеждает ask и правку входа; ask
// несёт updatedInput; шумная команда — только updatedInput; журнал пишет имя
// проверки; падение одной проверки не теряет вердикт другой; block обрывает
// остальные проверки события.

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
  const out = bash(sb, 'git commit --amend -m x')?.hookSpecificOutput || {};
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

// --- UserPromptSubmit: стёртый промпт без контекста ask mode ---
{
  const sb = sandbox();
  askOn(sb, 'sid-d');
  const ups = (prompt) => run(sb, 'UserPromptSubmit', { session_id: 'sid-d', prompt });
  check('ask mode: правило режима в additionalContext',
    ups('привет')?.hookSpecificOutput?.hookEventName, 'UserPromptSubmit');
  const out = ups('x'.repeat(100000));
  check('длинная вставка в ask mode: только block', [out?.decision, out?.hookSpecificOutput], ['block', undefined]);
}

// --- Stop: блок question-guard — ход не кончен, черновики целы ---
{
  const sb = sandbox();
  // cleanup на Stop чистит каталоги под HOME — песочница, не настоящий.
  sb.env.HOME = sb.dir;
  const draft = path.join(sb.dir, 'draft.log');
  bash(sb, `ls > ${draft}`);
  fs.writeFileSync(draft, '');
  const transcript = path.join(sb.dir, 't.jsonl');
  fs.writeFileSync(transcript, [
    { type: 'user', message: { role: 'user', content: 'почини' } },
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Починил.\n\nКоммитить сейчас?' }] } },
  ].map((r) => JSON.stringify(r)).join('\n') + '\n');
  const stop = (extra = {}) => run(sb, 'Stop', { session_id: 'sid-d', transcript_path: transcript, ...extra });
  check('вопрос текстом: block', stop()?.decision, 'block');
  check('Stop с блоком: черновик на месте', fs.existsSync(draft), true);
  check('повторный Stop: молчание', stop({ stop_hook_active: true }), null);
  check('повторный Stop: черновик убран', fs.existsSync(draft), false);
  check('Stop: журнал — block question-guard, без crash',
    records(sb).map((r) => [r.hook, r.decision]), [['question-guard', 'block']]);
}

// --- проект со своим ядром гардов: без links-context и deny security-guard ---
{
  const sb = sandbox();
  const domain = path.join(sb.cwd, 'docs', 'links');
  fs.mkdirSync(domain, { recursive: true });
  fs.writeFileSync(path.join(domain, 'INDEX.md'), '- x — `x.md` — x\n');
  fs.writeFileSync(path.join(domain, 'x.md'), '---\npaths:\n  - src/**\n---\n\n## События\n\n- `src/a.ts` ↔ `src/b.ts` — x\n');
  const edit = () => run(sb, 'PostToolUse', {
    session_id: 'sid-p', tool_name: 'Edit', tool_input: { file_path: path.join(sb.cwd, 'src', 'a.ts') },
  });
  const env = () => bash(sb, 'cat .env', 'sid-p')?.hookSpecificOutput?.permissionDecision;
  const push = () => bash(sb, 'git push --force origin main', 'sid-p')?.hookSpecificOutput?.permissionDecision;
  check('без ai/hooks/run.mjs: карта связей в контексте', Boolean(edit()?.hookSpecificOutput?.additionalContext), true);
  check('без ai/hooks/run.mjs: cat .env — deny', env(), 'deny');

  fs.mkdirSync(path.join(sb.cwd, 'ai', 'hooks'), { recursive: true });
  fs.writeFileSync(path.join(sb.cwd, 'ai', 'hooks', 'run.mjs'), '');
  check('run.mjs без подключённого хука: cat .env — deny', env(), 'deny');
  fs.mkdirSync(path.join(sb.cwd, '.claude'));
  fs.writeFileSync(path.join(sb.cwd, '.claude', 'settings.json'), '{"hooks":{"PreToolUse":[{"hooks":[{"command":"node ai/hooks/run.mjs claude pre"}]}]}}');
  check('с ai/hooks/run.mjs: карты связей нет', edit(), null);
  check('с ai/hooks/run.mjs: cat .env — решает проект', env(), undefined);
  check('с ai/hooks/run.mjs: ask на push остаётся', push(), 'ask');
}

// --- регистрация: наши хуки события — один вызов диспетчера ---
{
  const settings = JSON.parse(fs.readFileSync(path.join(ROOT, '..', 'claude', 'settings.json'), 'utf8'));
  for (const event of ['PreToolUse', 'PostToolUse', 'UserPromptSubmit', 'Stop']) {
    // ragsave-sync.sh — не проверка диспетчера: фоновая индексация своим процессом.
    const ours = settings.hooks[event].flatMap((g) => g.hooks).map((h) => h.command).filter((c) => /\.ai-hooks\/.*\.mjs/.test(c));
    check(`settings.json ${event}: только диспетчер`, ours, [`node "$HOME/.ai-hooks/claude/dispatch.mjs" ${event}`]);
  }
}

process.stdout.write(failed ? `\n=== ${failed} проверок упало ===\n` : '\n=== все проверки прошли ===\n');
process.exit(failed ? 1 : 0);
