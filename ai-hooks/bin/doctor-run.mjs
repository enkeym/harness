#!/usr/bin/env node
// Раннер фонового доктора: отдельный процесс, отвязанный от хука, который его
// породил. Хук должен выйти за миллисекунды, а headless-сессия работает минуты
// и кто-то должен дождаться её конца и записать итог в состояние — это он.
//
// Использование: doctor-run.mjs <state.json> <report.md> <prompt.md> <root>
// AI_HOOKS_DOCTOR_CMD подменяет `claude` (тесты).

import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { readJSON, writeJSON } from '../state-core.mjs';
import { claudeArgs, headlineOf } from '../doctor-core.mjs';

const RUN_TIMEOUT_MS = 10 * 60 * 1000;

const [stateFile, report, promptFile, root] = process.argv.slice(2);
if (!stateFile || !report || !promptFile || !root) process.exit(2);

function patch(fields) {
  writeJSON(stateFile, { ...readJSON(stateFile, {}), ...fields });
}

let prompt;
try {
  prompt = fs.readFileSync(promptFile, 'utf8');
} catch {
  patch({ status: 'failed', finished: Date.now(), exit: 'no-prompt' });
  process.exit(1);
}

patch({ status: 'running', pid: process.pid });

const cmd = process.env.AI_HOOKS_DOCTOR_CMD || 'claude';
const out = fs.openSync(report, 'w');
const err = fs.openSync(`${report}.log`, 'w');
const res = spawnSync(cmd, claudeArgs(prompt), {
  cwd: root,
  stdio: ['ignore', out, err],
  timeout: RUN_TIMEOUT_MS,
  env: process.env,
});
fs.closeSync(out);
fs.closeSync(err);

const exit = res.error ? (res.error.code || 'spawn-error') : res.status;
patch({
  status: exit === 0 ? 'done' : 'failed',
  finished: Date.now(),
  exit,
  headline: exit === 0 ? headlineOf(report) : null,
});
