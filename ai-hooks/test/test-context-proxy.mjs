import './env-isolate.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
function client(t, automation = true) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'context-proxy-'));
  const generation = path.join(dir, 'generation.json'); fs.writeFileSync(generation, 'one');
  const budget = path.join(dir, 'budget.log'); fs.writeFileSync(budget, '');
  const log = path.join(dir, 'calls.jsonl');
  const child = spawn(process.execPath, [path.join(here, '../bin/mcp-proxy.mjs'), '--', process.execPath, path.join(here, 'fixtures/context-mcp.mjs')], {
    env: { ...process.env, XDG_STATE_HOME: dir, CONTEXT_CALL_LOG: log, ...(automation ? { HARNESS_CONTEXT_GENERATION_FILE: generation, HARNESS_CONTEXT_OUTPUT_BUDGET_FILE: budget } : {}) },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  child.stderr.resume(); let id = 0; const pending = new Map();
  createInterface({ input: child.stdout }).on('line', line => {
    const m = JSON.parse(line); pending.get(m.id)?.(m); pending.delete(m.id);
  });
  const exited = new Promise(resolve => child.on('exit', resolve));
  t.after(async () => { child.stdin.end(); const timer = setTimeout(() => child.kill('SIGKILL'), 2000); await exited; clearTimeout(timer); fs.rmSync(dir, { recursive: true, force: true }); });
  return { generation, budget, dir, calls: () => fs.readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse),
    call(name, args = {}) {
      const current = ++id;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('proxy timed out')), 4000);
        pending.set(current, value => { clearTimeout(timer); resolve(value); });
        child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: current, method: 'tools/call', params: { name, arguments: args } })}\n`);
      });
    } };
}

test('proxy suppresses only content still held in the current generation', async t => {
  const c = client(t);
  const args = { file: 'a', mode: 'lines', lines: '1-2' };
  assert.match((await c.call('tokensave_read', args)).result.content[0].text, /useful content/);
  assert.equal((await c.call('tokensave_read', args)).result.content[0].text, 'unchanged: true');
  assert.equal(c.calls()[1].arguments.if_digest, 'a'.repeat(64));
  fs.writeFileSync(c.generation, 'two');
  assert.match((await c.call('tokensave_read', args)).result.content[0].text, /useful content/);
  assert.equal(c.calls()[2].arguments.if_digest, undefined);
  await c.call('tokensave_read', { ...args, graph_root: '/another/project' });
  assert.equal(c.calls()[3].arguments.graph_root, '/another/project');
});

test('aggregate adapter budget preserves full artifacts and never caches truncated reads', async t => {
  const c = client(t);
  const results = await Promise.all([c.call('large'), c.call('large')]);
  const bytes = results.reduce((sum, r) => sum + r.result.content.reduce((n, b) => n + Buffer.byteLength(b.text), 0), 0);
  assert.ok(bytes <= 13000);
  for (const { result } of results) {
    const artifact = JSON.parse(fs.readFileSync(result._meta.harnessFullResult));
    assert.equal(artifact.content[0].text, 'я'.repeat(20000));
  }
  await c.call('tokensave_read', { file: 'a' });
  await c.call('tokensave_read', { file: 'a' });
  assert.equal(c.calls().at(-1).arguments.if_digest, undefined, 'hidden content is not held by the model');
});

test('finite retries/circuit apply to safe reads and never to writes', async t => {
  const c = client(t);
  for (let i = 0; i < 3; i++) assert.equal((await c.call('tokensave_search', { failure: 'invalid argument' })).error.code, -32602);
  assert.equal(c.calls().length, 2);
  await c.call('tokensave_read', { transport: true });
  assert.equal(c.calls().filter(x => x.name === 'tokensave_read').length, 3);
  const response = await c.call('tokensave_edit', { transport: true });
  assert.equal(response.error.message, 'ECONNRESET');
  assert.equal(c.calls().filter(x => x.name === 'tokensave_edit').length, 1);
});

test('fixed workload preserves outcomes while reducing emitted text and duplicate backend errors', async t => {
  const measured = [];
  for (const automation of [false, true]) {
    const c = client(t, automation); let emittedBytes = 0; let successes = 0; let errors = 0;
    for (const [name, args] of [['tokensave_read', { file: 'a' }], ['tokensave_read', { file: 'a' }],
      ['large', {}], ['large', {}], ...Array.from({ length: 3 }, () => ['tokensave_search', { failure: 'invalid argument' }])]) {
      const result = await c.call(name, args);
      emittedBytes += Buffer.byteLength(JSON.stringify(result));
      if (result.error) errors++; else successes++;
      if (name === 'large') {
        const full = result.result._meta?.harnessFullResult ? JSON.parse(fs.readFileSync(result.result._meta.harnessFullResult)) : result.result;
        assert.equal(full.content[0].text, 'я'.repeat(20000));
      }
    }
    measured.push({ automation, emittedBytes, successes, errors, backendCalls: c.calls().length,
      backendErrors: c.calls().filter(x => x.arguments?.failure).length });
  }
  assert.equal(measured[0].successes, measured[1].successes); assert.equal(measured[0].errors, measured[1].errors);
  assert.ok(measured[1].emittedBytes < measured[0].emittedBytes / 2);
  assert.equal(measured[1].backendCalls, measured[0].backendCalls - 1);
  console.log(`context_benchmark=${JSON.stringify(measured)}`);
});
