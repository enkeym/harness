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
function client(t, automation = true, policy = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'context-proxy-'));
  const generation = path.join(dir, 'generation.json'); fs.writeFileSync(generation, JSON.stringify({ v: 1, task: 'one', generation: 1 }));
  const budget = path.join(dir, 'budget.log'); fs.writeFileSync(budget, '');
  const log = path.join(dir, 'calls.jsonl');
  const policyFile = path.join(dir, 'policy.json'); fs.writeFileSync(policyFile, JSON.stringify(policy));
  const clock = path.join(dir, 'clock'); fs.writeFileSync(clock, '100000');
  const child = spawn(process.execPath, ['--import', path.join(here, 'fixtures/proxy-clock.mjs'), path.join(here, '../bin/mcp-proxy.mjs'), '--', process.execPath, path.join(here, 'fixtures/context-mcp.mjs')], {
    env: { ...process.env, XDG_STATE_HOME: dir, CONTEXT_CALL_LOG: log, HARNESS_MCP_POLICY_FILE: policyFile, PROXY_CLOCK: clock, HARNESS_CONTEXT_GENERATION_FILE: '', HARNESS_CONTEXT_OUTPUT_BUDGET_FILE: '', ...(automation ? { HARNESS_CONTEXT_GENERATION_FILE: generation, HARNESS_CONTEXT_OUTPUT_BUDGET_FILE: budget } : {}) },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  child.stderr.resume(); let id = 0; const pending = new Map();
  createInterface({ input: child.stdout }).on('line', line => {
    const m = JSON.parse(line); pending.get(m.id)?.(m); pending.delete(m.id);
  });
  const exited = new Promise(resolve => child.on('exit', resolve));
  t.after(async () => { child.stdin.end(); const timer = setTimeout(() => child.kill('SIGKILL'), 2000); await exited; clearTimeout(timer); fs.rmSync(dir, { recursive: true, force: true }); });
  return { generation, budget, dir, clock, calls: () => fs.readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse),
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
  fs.writeFileSync(c.generation, JSON.stringify({ v: 1, task: 'one', generation: 2 }));
  assert.match((await c.call('tokensave_read', args)).result.content[0].text, /useful content/);
  assert.equal(c.calls()[2].arguments.if_digest, undefined);
  await c.call('tokensave_read', { ...args, graph_root: '/another/project' });
  assert.equal(c.calls()[3].arguments.graph_root, '/another/project');
});

test('aggregate adapter budget preserves full artifacts and never caches truncated reads', async t => {
  const c = client(t);
  const results = await Promise.all([c.call('large'), c.call('large')]);
  const bytes = results.reduce((sum, r) => sum + r.result.content.reduce((n, b) => n + Buffer.byteLength(b.text), 0), 0);
  const markers = results.reduce((sum, r) => sum + Buffer.byteLength(r.result.content.at(-1).text), 0);
  assert.ok(bytes - markers <= 13000);
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
  for (const optimized of [false, true]) {
    const c = client(t, false, optimized ? {} : { outputEnabled: false, errorsEnabled: false }); let emittedBytes = 0; let successes = 0; let errors = 0;
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
    measured.push({ optimized, emittedBytes, successes, errors, backendCalls: c.calls().length,
      backendErrors: c.calls().filter(x => x.arguments?.failure).length });
  }
  assert.equal(measured[0].successes, measured[1].successes); assert.equal(measured[0].errors, measured[1].errors);
  assert.ok(measured[1].emittedBytes < measured[0].emittedBytes / 2);
  assert.equal(measured[1].backendCalls, measured[0].backendCalls - 1);
  console.log(`context_benchmark=${JSON.stringify(measured)}`);
});

test('ordinary sessions bound text and retrieve exact artifacts or UTF-8 ranges through MCP', async t => {
  const c = client(t, false);
  const { result } = await c.call('large');
  assert.ok(Buffer.byteLength(result.content.map(b => b.text).join('')) <= 13000);
  const file = result._meta.harnessFullResult;
  assert.match(result.content.at(-1).text, /harness_read_result/);
  const range = (await c.call('harness_read_result', { path: file, offset: 2, bytes: 9 })).result;
  assert.equal(range.content[0].text, 'я'.repeat(4));
  assert.deepEqual(range.structuredContent, { offset: 2, nextOffset: 10, totalBytes: 40000 });
  const full = (await c.call('harness_read_result', { path: file, full: true })).result;
  assert.equal(full.content[0].text, 'я'.repeat(20000));
  assert.equal(full._meta, undefined);
  assert.equal(c.calls().length, 1);
  assert.equal((await c.call('harness_read_result', { path: file, offset: 1 })).error.code, -32602);
  assert.equal((await c.call('harness_read_result', { path: c.generation })).error.code, -32602);
});

test('artifact write failure returns successful unabridged backend output', async t => {
  const c = client(t, false);
  fs.writeFileSync(path.join(c.dir, 'harness'), 'blocked');
  const { result } = await c.call('large');
  assert.equal(result.content[0].text, 'я'.repeat(20000));
  assert.equal(result._meta, undefined);
  assert.match((await c.call('tokensave_read', { file: 'a' })).result.content[0].text, /useful/);
});

test('unknown lifecycle never injects digests and explicit digest and force survive', async t => {
  const c = client(t, false);
  await c.call('tokensave_read', { file: 'a' }); await c.call('tokensave_read', { file: 'a' });
  assert.equal(c.calls()[1].arguments.if_digest, undefined);
  await c.call('tokensave_read', { file: 'a', if_digest: 'a'.repeat(64) });
  assert.equal(c.calls()[2].arguments.if_digest, 'a'.repeat(64));
  const managed = client(t);
  await managed.call('tokensave_read', { file: 'a' });
  await managed.call('tokensave_read', { file: 'a', force: true });
  assert.equal(managed.calls().at(-1).arguments.if_digest, undefined);
  fs.writeFileSync(managed.generation, '{invalid');
  await managed.call('tokensave_read', { file: 'a' });
  assert.equal(managed.calls().at(-1).arguments.if_digest, undefined);
  fs.writeFileSync(managed.generation, JSON.stringify({ v: 1, task: 'new-session', generation: 1, model: 'new-model' }));
  await managed.call('tokensave_read', { file: 'a' });
  assert.equal(managed.calls().at(-1).arguments.if_digest, undefined);
  fs.unlinkSync(managed.generation);
  assert.ok((await managed.call('large')).result.content[0].text.length > 0);
});

test('circuit normalizes arguments and allows a successful probe after expiry without lifecycle', async t => {
  const c = client(t, false);
  const failure = { failure: 'invalid argument', recover: true };
  await c.call('tokensave_search', failure); await c.call('tokensave_search', failure);
  const suppressed = await c.call('tokensave_search', { recover: true, failure: 'invalid argument' });
  assert.equal(c.calls().length, 2);
  assert.match(suppressed.error.message, /suppressed temporarily/);
  fs.writeFileSync(c.clock, '130001');
  const recovered = await c.call('tokensave_search', failure);
  assert.equal(recovered.error, undefined);
  await c.call('tokensave_search', failure);
  assert.equal(c.calls().length, 4);
});

test('unknown failures never open the circuit, writes and unknown tools never retry', async t => {
  const c = client(t, false);
  for (let i = 0; i < 3; i++) await c.call('tokensave_search', { failure: 'unclassified backend failure' });
  assert.equal(c.calls().length, 3);
  await c.call('tokensave_edit', { transport: true });
  await c.call('unknown', { transport: true });
  assert.equal(c.calls().length, 5);
});

test('changed file content is validated by the backend even when a held digest is injected', async t => {
  const c = client(t);
  const file = path.join(c.dir, 'source'); fs.writeFileSync(file, 'first content');
  await c.call('tokensave_read', { file });
  fs.writeFileSync(file, 'updated content');
  assert.match((await c.call('tokensave_read', { file })).result.content[0].text, /updated content/);
  assert.ok(c.calls()[1].arguments.if_digest);
  assert.equal((await c.call('tokensave_read', { file })).result.content[0].text, 'unchanged: true');
  assert.notEqual(c.calls()[1].arguments.if_digest, c.calls()[2].arguments.if_digest);
});

test('an observed index creation clears the missing-index circuit immediately', async t => {
  const c = client(t, false);
  const args = { graph_root: c.dir, failure: 'missing index', recover: true };
  await c.call('tokensave_search', args); await c.call('tokensave_search', args);
  assert.match((await c.call('tokensave_search', args)).error.message, /suppressed/);
  fs.mkdirSync(path.join(c.dir, '.tokensave'));
  fs.writeFileSync(path.join(c.dir, '.tokensave/tokensave.db'), 'fixture');
  assert.equal((await c.call('tokensave_search', args)).error, undefined);
  assert.equal(c.calls().length, 3);
});

test('compaction while an automatic digest request is in flight fetches the complete text again', async t => {
  const c = client(t);
  const args = { file: 'a', invalidateGeneration: true };
  await c.call('tokensave_read', args);
  const response = await c.call('tokensave_read', args);
  assert.match(response.result.content[0].text, /useful content/);
  assert.equal(c.calls().length, 3);
  assert.equal(c.calls()[1].arguments.if_digest, 'a'.repeat(64));
  assert.equal(c.calls()[2].arguments.if_digest, undefined);
});

test('RAG circuit observes the explicit project database rather than the proxy working directory', async t => {
  const c = client(t, false);
  const args = { project: c.dir, failure: 'индекс для проекта не построен', recover: true };
  await c.call('rag_search', args); await c.call('rag_search', args);
  assert.match((await c.call('rag_search', args)).error.message, /suppressed/);
  fs.mkdirSync(path.join(c.dir, '.ragsave'));
  fs.writeFileSync(path.join(c.dir, '.ragsave/rag.db'), 'fixture');
  assert.equal((await c.call('rag_search', args)).error, undefined);
  assert.equal(c.calls().length, 3);
});
