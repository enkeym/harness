import './env-isolate.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

const script = new URL('../bin/skill-context.mjs', import.meta.url);

for (const event of ['SessionStart', 'UserPromptSubmit']) {
  test(`${event}: delivers shared skill routing without retaining the prompt`, () => {
    const result = spawnSync(process.execPath, [script.pathname], {
      input: JSON.stringify({ hook_event_name: event, prompt: 'private-user-input' }),
      encoding: 'utf8', timeout: 10000,
    });
    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.equal(output.hookSpecificOutput.hookEventName, event);
    const context = output.hookSpecificOutput.additionalContext;
    if (event === 'SessionStart') {
      for (const skill of ['task-brief', 'handoff', 'react-frontend', 'nestjs-backend', 'python']) {
        assert.ok(context.includes(skill), skill);
      }
      assert.match(context, /Read applicable SKILL.md only when its contents are missing from the current context or have changed/);
      assert.match(context, /restore missing instructions after compaction or session transfer/);
    } else {
      assert.match(context, /core\.md/);
      assert.match(context, /missing from the current context or have changed/);
      assert.equal(context.includes('task-brief'), false);
      assert.ok(context.length < 400);
    }
    assert.equal(context.includes('private-user-input'), false);
    assert.equal(output.decision, undefined);
    assert.equal(output.continue, undefined);
  });
}

test('unrelated events do not inject context', () => {
  const result = spawnSync(process.execPath, [script.pathname], {
    input: JSON.stringify({ hook_event_name: 'Stop' }), encoding: 'utf8', timeout: 10000,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, '');
});

test('malformed input reports a nonblocking failure without exposing its contents', () => {
  const result = spawnSync(process.execPath, [script.pathname], {
    input: 'private-invalid-json', encoding: 'utf8', timeout: 10000,
  });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /skill context could not be loaded/);
  assert.equal(result.stderr.includes('private-invalid-json'), false);
});
