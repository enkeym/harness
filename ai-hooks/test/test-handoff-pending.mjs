#!/usr/bin/env node
// Тест передачи handoff без очистки контекста: одобренный ExitPlanMode со
// снимком ставит метку, SessionStart (clear/startup) того же корня отдаёт
// снимок один раз; обычный план, чужой корень, протухшая метка, промпт в
// пометившей сессии и та же сессия метку не дают.

import './env-isolate.mjs';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { check as mark } from '../claude/handoff-mark.mjs';
import { check as drop } from '../claude/handoff-drop.mjs';
import { check as pickup } from '../claude/handoff-pickup.mjs';
import { takePending } from '../handoff-core.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'handoff-pending-'));

let failed = 0;
const check = (name, ok, detail = '') => {
  process.stdout.write(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}\n`);
  if (!ok) failed++;
};

const SNAPSHOT = '## Задача\nx\n\n## Состояние\ny\n\n## Дальше\n1. z\n';
const planFile = path.join(dir, 'plan.md');
fs.writeFileSync(planFile, SNAPSHOT);
const other = fs.mkdtempSync(path.join(os.tmpdir(), 'handoff-other-'));

const exit = (over = {}) => ({ tool_name: 'ExitPlanMode', cwd: dir, session_id: 'old',
  tool_input: { plan: SNAPSHOT, planFilePath: planFile }, ...over });
const start = (over = {}) => ({ source: 'clear', cwd: dir, session_id: 'new', ...over });

mark(exit());
const hit = pickup(start());
check('clear: снимок отдан', hit?.context.includes(`@${planFile}`) && hit.context.includes('Дальше'), hit?.context);
check('снимок отдаётся один раз', pickup(start()) === null);

mark(exit());
check('startup: тоже отдаёт', pickup(start({ source: 'startup' })) !== null);

mark(exit());
check('resume и compact не берут метку', pickup(start({ source: 'resume' })) === null && pickup(start({ source: 'compact' })) === null);
check('метка осталась после resume', pickup(start()) !== null);

mark(exit({ tool_input: { plan: '## Задача\nобычный план\n', planFilePath: planFile } }));
check('обычный план метки не ставит', pickup(start()) === null);

mark(exit({ tool_input: { planFilePath: planFile } }));
check('текст плана читается из planFilePath', pickup(start()) !== null);

mark(exit());
check('чужой корень не получает', pickup(start({ cwd: other })) === null);
check('чужой корень не сжёг метку', pickup(start()) !== null);
fs.rmSync(other, { recursive: true, force: true });

mark(exit());
check('та же сессия не получает свою метку', pickup(start({ session_id: 'old' })) === null);

mark(exit());
drop({ cwd: dir, session_id: 'old' });
check('промпт в пометившей сессии снимает метку', pickup(start()) === null);

mark(exit());
drop({ cwd: dir, session_id: 'foreign' });
check('промпт чужой сессии метку не трогает', pickup(start()) !== null);

mark(exit());
check('протухшая метка не отдаётся', takePending(dir, 'new', Date.now() + 13 * 3600 * 1000) === null);

mark(exit({ tool_input: { plan: SNAPSHOT, planFilePath: path.join(dir, 'gone.md') } }));
check('снимка на диске нет — молчит', pickup(start()) === null);

const run = (script, input) => execFileSync('node', [path.join(ROOT, 'claude', script)], { input: JSON.stringify(input), encoding: 'utf8' });
run('handoff-mark.mjs', { ...exit(), hook_event_name: 'PostToolUse' });
const out = JSON.parse(run('handoff-pickup.mjs', { ...start(), hook_event_name: 'SessionStart' }));
check('скрипт: additionalContext SessionStart', out.hookSpecificOutput?.hookEventName === 'SessionStart'
  && out.hookSpecificOutput.additionalContext?.includes(planFile) && out.systemMessage?.includes('handoff'));
check('скрипт: повтор — пустой вывод', run('handoff-pickup.mjs', start()) === '');

fs.rmSync(dir, { recursive: true, force: true });
process.stdout.write(failed ? `\n${failed} FAIL\n` : '\nвсе проверки прошли\n');
process.exit(failed ? 1 : 0);
