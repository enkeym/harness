import './env-isolate.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const script = path.join(root, 'ai-hooks/bin/mcp-search-guard.mjs');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-search-guard-'));
const fake = path.join(dir, 'tokensave');
const capture = path.join(dir, 'input.json');
fs.writeFileSync(fake, `#!${process.execPath}
const fs = require('node:fs');
fs.writeFileSync(process.env.GUARD_CAPTURE, fs.readFileSync(0, 'utf8'));
if (process.env.GUARD_FAILURE) process.exit(1);
console.log(JSON.stringify(process.env.GUARD_ALLOW ? {permission:'allow'} : {
  permission:'deny', agent_message:'Use tokensave_search. To override for this one call, set TOKENSAVE_DISABLE_GREP_HOOK=1 in the shell.'
}));
`, { mode: 0o755 });
const run = (tool, args, extra = {}) => {
  const result = spawnSync(process.execPath, [script], {
    input: JSON.stringify({ tool_name: tool, cwd: dir, tool_input: args }),
    env: { ...process.env, AI_HOOKS_TOKENSAVE_CMD: fake, GUARD_CAPTURE: capture, ...extra },
    encoding: 'utf8', timeout: 10000,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  return result.stdout ? JSON.parse(result.stdout) : null;
};

const denied = run('Bash', { command: 'rg symbol src' });
assert.equal(denied.hookSpecificOutput.permissionDecision, 'deny');
assert.match(denied.hookSpecificOutput.permissionDecisionReason, /rag_search/);
assert.doesNotMatch(denied.hookSpecificOutput.permissionDecisionReason, /TOKENSAVE_DISABLE|To override/);
run('functions.exec_command', { cmd: 'rg symbol src', workdir: root });
const normalized = JSON.parse(fs.readFileSync(capture, 'utf8'));
assert.equal(normalized.tool_name, 'Bash');
assert.equal(normalized.tool_input.command, 'rg symbol src');
assert.equal(normalized.cwd, root);
assert.equal(run('Bash', { command: 'git diff' }, { GUARD_ALLOW: '1' }), null);
assert.equal(run('mcp__ragsave__rag_search', { query: 'deploy' }), null);
assert.equal(run('Bash', { command: 'TOKENSAVE_DISABLE_GREP_HOOK=1 rg symbol' }).hookSpecificOutput.permissionDecision, 'deny');
assert.match(run('Bash', { command: 'rg symbol' }, { GUARD_FAILURE: '1' }).systemMessage, /недоступен/);

// Реальный TokenSave: индексируем только временный проект, команды поиска не исполняем.
const project = path.join(dir, 'project');
fs.mkdirSync(project);
fs.writeFileSync(path.join(project, 'example.js'), 'export function sampleSymbol() { return 1; }\n');
const init = spawnSync('tokensave', ['init', '--no-git-hook', '--cpu-usage', 'low', project], {
  env: { ...process.env, HOME: dir }, encoding: 'utf8', timeout: 30000,
});
assert.equal(init.status, 0, init.stdout + init.stderr);
const actual = (command) => {
  const result = spawnSync(process.execPath, [script], {
    input: JSON.stringify({ tool_name: 'Bash', cwd: project, tool_input: { command } }),
    env: { ...process.env, HOME: dir, AI_HOOKS_TOKENSAVE_CMD: 'tokensave' }, encoding: 'utf8', timeout: 10000,
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout ? JSON.parse(result.stdout) : null;
};
assert.equal(actual('rg sampleSymbol .').hookSpecificOutput.permissionDecision, 'deny');
assert.equal(actual('git diff'), null);
console.log('MCP search guard: deny/allow, hints, Codex aliases, fallback and real TokenSave passed');
