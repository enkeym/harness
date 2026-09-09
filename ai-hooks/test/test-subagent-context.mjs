#!/usr/bin/env node
// Тест SubagentStart-хука: в tokensave-проекте контекст с правилом есть,
// вне проекта хук молчит. Запуск — через реальный скрипт, как это делает Claude.

import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SCRIPT = path.join(ROOT, 'claude', 'subagent-context.mjs');

const TS_PROJECT = '/home/enkeym/main/web_groza';
const NON_PROJECT = '/tmp';

function run(cwd) {
  const out = execFileSync('node', [SCRIPT], {
    input: JSON.stringify({
      session_id: 'test', cwd, hook_event_name: 'SubagentStart',
      agent_id: 'a1', agent_type: 'general-purpose',
    }),
    encoding: 'utf8',
  });
  return out.trim() ? JSON.parse(out) : null;
}

let failed = 0;
function check(name, ok, detail = '') {
  process.stdout.write(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}\n`);
  if (!ok) failed++;
}

const inProject = run(TS_PROJECT);
const ctx = inProject?.hookSpecificOutput?.additionalContext || '';
check('tokensave-проект: событие SubagentStart', inProject?.hookSpecificOutput?.hookEventName === 'SubagentStart');
check('tokensave-проект: правило tokensave в контексте', /mcp__tokensave__tokensave_read/.test(ctx));
check('tokensave-проект: правило ragsave в контексте', /rag_search/.test(ctx));
check('tokensave-проект: запрет на своих субагентов', /субагентов не запускай/.test(ctx));

const outside = run(NON_PROJECT);
check('вне проекта: хук молчит', outside === null, outside ? JSON.stringify(outside).slice(0, 80) : '');

process.stdout.write(failed ? `\n${failed} FAIL\n` : '\nвсе проверки прошли\n');
process.exit(failed ? 1 : 0);
