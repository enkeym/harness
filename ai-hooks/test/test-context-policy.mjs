import './env-isolate.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AppServer } from '../bin/context-runner.mjs';
import { syncCodexContext } from '../../bin/codex-context.mjs';
import { contextPolicy, handoffPrompt } from '../bin/context-policy.mjs';

test('native Codex config preserves custom settings and prompt across installation and read-only checks', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'context-policy-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const config = path.join(dir, 'config.toml');
  fs.writeFileSync(config, 'model = "personal-model"\ncompact_prompt = "Preserve custom rules."\n');
  const client = () => new AppServer({ cwd: dir, env: { ...process.env, CODEX_HOME: dir, HARNESS_CONTEXT_GENERATION_FILE: '' } });
  const initial = fs.readFileSync(config, 'utf8');

  assert.equal(await syncCodexContext({ cwd: dir, check: true, client: client() }), 1);
  assert.equal(fs.readFileSync(config, 'utf8'), initial);
  assert.equal(await syncCodexContext({ cwd: dir, client: client() }), 0);
  const installed = fs.readFileSync(config, 'utf8');
  assert.match(installed, /personal-model/);
  assert.match(installed, /Preserve custom rules/);
  assert.match(installed, /model_auto_compact_token_limit = 90000/);
  assert.match(installed, /model_auto_compact_token_limit_scope = "total"/);
  assert.equal(await syncCodexContext({ cwd: dir, client: client() }), 0);
  assert.equal(await syncCodexContext({ cwd: dir, check: true, client: client() }), 0);
  assert.equal(fs.readFileSync(config, 'utf8'), installed);
  assert.equal(installed.split('Harness automatic Handoff.').length, 2);
  assert.match(handoffPrompt, /remaining plan/);
  assert.equal(contextPolicy.maxTokens - contextPolicy.startTokens, 60000);
});
