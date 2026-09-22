#!/usr/bin/env node
// Тесты гейта скиллов: метка ставится с инструмента Skill и с промпта
// `/name`, живёт по сессии; правка файлов инструкций без skill-authoring и
// git commit без ревью-скиллов запрещаются с подсказкой, всё остальное
// проходит; выключатели и ребёнок-доктор пропускают.

import './env-isolate.mjs';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const GATE = path.join(ROOT, 'claude', 'skill-gate.mjs');
const TRACK = path.join(ROOT, 'claude', 'skill-track.mjs');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-gate-'));
const env = {
  ...process.env,
  AI_HOOKS_STATE_DIR: path.join(tmp, 'state'),
  AI_HOOKS_HOOKS_LOG: path.join(tmp, 'hooks.jsonl'),
};
delete env.AI_HOOKS_SKILL_GATE_OFF;
delete env.AI_HOOKS_DOCTOR;

const { isGitCommit, isInstructionFile, skillName } = await import('../skill-core.mjs');

let failed = 0;
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  process.stdout.write(`${ok ? 'ok  ' : 'FAIL'} ${name} (got=${JSON.stringify(got)}, want=${JSON.stringify(want)})\n`);
  if (!ok) failed++;
}

function run(script, input, extraEnv = {}) {
  const res = spawnSync('node', [script], { input: JSON.stringify(input), encoding: 'utf8', env: { ...env, ...extraEnv } });
  return { status: res.status, out: res.stdout.trim() };
}

// 'allow' | 'deny' | причина
function gate(sid, tool_name, tool_input, extraEnv) {
  const { out } = run(GATE, { session_id: sid, tool_name, tool_input, cwd: tmp }, extraEnv);
  if (!out) return 'allow';
  const o = JSON.parse(out).hookSpecificOutput;
  return o.permissionDecision === 'deny' ? `deny: ${o.permissionDecisionReason}` : o.permissionDecision;
}
const decision = (r) => r.split(':')[0];

const loadViaTool = (sid, skill) =>
  run(TRACK, { session_id: sid, tool_name: 'Skill', tool_input: { skill }, cwd: tmp });
const loadViaPrompt = (sid, prompt) =>
  run(TRACK, { session_id: sid, prompt, cwd: tmp });

const SKILL_MD = '/home/enkeym/harness/skills/doctor/SKILL.md';
const edit = (p) => ({ file_path: p, old_string: 'a', new_string: 'b' });
const bash = (command) => ({ command });

// --- чистые функции ---
{
  check('файл: SKILL.md харнеса', isInstructionFile(SKILL_MD), true);
  check('файл: reference скилла', isInstructionFile('/home/x/.claude/skills/git-flow/reference/mr.md'), true);
  check('файл: команда', isInstructionFile('/home/x/harness/claude/commands/ask.md'), true);
  check('файл: CLAUDE.md проекта', isInstructionFile('/home/x/main/web_groza/CLAUDE.md'), true);
  check('файл: общие правила', isInstructionFile('/home/x/harness/rules/core.md'), true);
  check('файл: AGENTS.md', isInstructionFile('/home/x/harness/opencode/AGENTS.md'), true);
  check('файл: агент OpenCode', isInstructionFile('/home/x/harness/opencode/agent/commit.md'), true);
  check('файл: скилл через ~/.config/opencode', isInstructionFile('/home/x/.config/opencode/skills/git-flow/SKILL.md'), true);
  check('файл: docs/rules проекта', isInstructionFile('/home/x/app/docs/rules/style.md'), false);
  check('файл: обычный md', isInstructionFile('/home/x/main/web_groza/README.md'), false);
  check('файл: commands вне .claude', isInstructionFile('/home/x/app/src/commands/deploy.md'), false);
  check('файл: память не файл инструкций', isInstructionFile('/home/x/.claude/projects/-home-x/memory/a.md'), false);

  check('commit: простой', isGitCommit('git commit -m "x"'), true);
  check('commit: с -C', isGitCommit('git -C /home/x/harness commit -F -'), true);
  check('commit: в пайпе', isGitCommit('printf "msg" | git commit -F -'), true);
  check('commit: после &&', isGitCommit('git add -A && git commit -q -m x'), true);
  check('commit: git log не коммит', isGitCommit('git log --oneline -3'), false);
  check('commit: commit-tree не коммит', isGitCommit('git commit-tree HEAD^{tree}'), false);
  check('commit: слово в аргументе', isGitCommit('grep -rn commit src/'), false);
  check('commit: пусто', isGitCommit(''), false);
check('commit: за sudo', isGitCommit('sudo git commit -m x'), true);
check('commit: за env с присваиванием', isGitCommit('env GIT_AUTHOR_NAME=x git commit -m x'), true);
check('commit: после фонового &', isGitCommit('npm test & git commit -m x'), true);
check('commit: в подоболочке', isGitCommit('(cd /tmp && git commit -m x)'), true);
check('commit: в $(…)', isGitCommit('echo $(git commit -m x)'), true);
check('commit: --config-env со значением', isGitCommit('git --config-env x=Y commit -m x'), true);
check('commit: sudo -u git — git как значение опции', isGitCommit('sudo -u git git commit -m x'), true);
check('commit: sudo git log не коммит', isGitCommit('sudo git log --grep commit'), false);

  check('имя: plugin:skill', skillName('plugin:skill-authoring'), 'skill-authoring');
  check('имя: scoped', skillName('apps/web:deploy'), 'deploy');
}

// --- правка файлов инструкций ---
{
  const r = gate('sid-a', 'Edit', edit(SKILL_MD));
  check('SKILL.md без скилла → deny', decision(r), 'deny');
  check('… причина называет Skill(skill-authoring)', r.includes('Skill(skill-authoring)'), true);
  check('… причина не подсказывает выключатель', r.includes('skill-gate.off'), false);
  check('Write CLAUDE.md без скилла → deny', decision(gate('sid-a', 'Write', { file_path: '/home/x/p/CLAUDE.md', content: '' })), 'deny');
  check('обычный файл → allow', gate('sid-a', 'Edit', edit('/home/x/p/src/a.ts')), 'allow');
  check('Read SKILL.md → allow (гейт только на правку)', gate('sid-a', 'Read', { file_path: SKILL_MD }), 'allow');

  const log = fs.readFileSync(env.AI_HOOKS_HOOKS_LOG, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  check('запрет в hooks.jsonl с именем хука', [log[0]?.hook, log[0]?.decision, log[0]?.sid], ['skill-gate', 'deny', 'sid-a']);

  loadViaTool('sid-a', 'skill-authoring');
  check('после Skill(skill-authoring) → allow', gate('sid-a', 'Edit', edit(SKILL_MD)), 'allow');
  check('другая сессия — по-прежнему deny', decision(gate('sid-b', 'Edit', edit(SKILL_MD))), 'deny');

  loadViaPrompt('sid-b', '/skill-authoring проверь скиллы');
  check('промпт /skill-authoring ставит метку → allow', gate('sid-b', 'Edit', edit(SKILL_MD)), 'allow');
  loadViaTool('sid-c', 'plugin:skill-authoring');
  check('plugin:skill-authoring → allow', gate('sid-c', 'Edit', edit(SKILL_MD)), 'allow');
  loadViaPrompt('sid-d', 'обычный промпт без слэша');
  check('обычный промпт метку не ставит', decision(gate('sid-d', 'Edit', edit(SKILL_MD))), 'deny');
}

// --- git commit ---
{
  const r = gate('sid-g', 'Bash', bash('git commit -m "feat: x"'));
  check('commit без ревью → deny', decision(r), 'deny');
  check('… перечислены все три скилла', ['review-standards', 'review-security', 'git-flow'].every((s) => r.includes(s)), true);
  check('git status → allow', gate('sid-g', 'Bash', bash('git status --short')), 'allow');

  loadViaTool('sid-g', 'review-standards');
  loadViaTool('sid-g', 'review-security');
  const r2 = gate('sid-g', 'Bash', bash('git commit -m x'));
  check('два из трёх → deny, не хватает git-flow', decision(r2) === 'deny' && r2.includes('git-flow') && !r2.includes('review-standards'), true);
  loadViaTool('sid-g', 'git-flow');
  check('все три → allow', gate('sid-g', 'Bash', bash('git -C /home/x/harness commit -F -')), 'allow');
}

// --- выключатели и fail-open ---
{
  check('без session_id → allow', gate(undefined, 'Edit', edit(SKILL_MD)), 'allow');
  check('AI_HOOKS_SKILL_GATE_OFF=1 → allow', gate('sid-off', 'Edit', edit(SKILL_MD), { AI_HOOKS_SKILL_GATE_OFF: '1' }), 'allow');
  check('внутри доктора → allow', gate('sid-doc', 'Bash', bash('git commit -m x'), { AI_HOOKS_DOCTOR: '1' }), 'allow');
  fs.mkdirSync(env.AI_HOOKS_STATE_DIR, { recursive: true });
  fs.writeFileSync(path.join(env.AI_HOOKS_STATE_DIR, 'skill-gate.off'), '');
  check('файл state/skill-gate.off → allow', gate('sid-off', 'Edit', edit(SKILL_MD)), 'allow');
  fs.unlinkSync(path.join(env.AI_HOOKS_STATE_DIR, 'skill-gate.off'));
  check('битое состояние → deny как обычно', (() => {
    fs.writeFileSync(path.join(env.AI_HOOKS_STATE_DIR, 'skills-loaded.json'), '{broken');
    return decision(gate('sid-z', 'Edit', edit(SKILL_MD)));
  })(), 'deny');
  check('track на битом состоянии не падает', run(TRACK, { session_id: 'sid-z', tool_name: 'Skill', tool_input: { skill: 'git-flow' }, cwd: tmp }).status, 0);
}

process.stdout.write(failed ? `\n=== ${failed} проверок упало ===\n` : '\n=== все проверки прошли ===\n');
process.exit(failed ? 1 : 0);
