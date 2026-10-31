import './env-isolate.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runObjective, chooseAction, defaultPolicy, validateCheckpoint, policyFor, AppServer, mcpEnvironmentOverrides } from '../bin/context-runner.mjs';

function checkpoint(ack, steps, status = 'running') {
  return { ack, completedSteps: steps, status, latestSteering: '', constraints: 'no push', decisions: '',
    changedPaths: 'test', verification: 'fixture input checked', unresolved: '', nextAction: 'continue', result: 'done' };
}
function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'context-runner-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return dir;
}
function backend({ finishAt = 4, unresolved = false, crash = false, stalled = false, pendingTools = false, reroute = false } = {}) {
  const requests = []; let turn = 0; let threads = 0; let pending; let onEvent;
  const observations = [];
  return { requests, observations, factory(options) {
    onEvent = options.onEvent;
    return { async initialize() {}, close() {}, async request(method, params) {
      requests.push({ method, params });
      if (method === 'thread/start') return { thread: { id: `thread-${++threads}` } };
      if (method === 'thread/compact/start') {
        onEvent({ method: 'item/completed', params: { threadId: params.threadId, item: { id: 'compact', type: 'contextCompaction' } } });
        pending = { method: 'item/completed', params: { threadId: params.threadId, item: { type: 'contextCompaction' } } }; return {};
      }
      if (method === 'turn/start') {
        if (crash) throw new Error('transport closed');
        const before = JSON.parse(fs.readFileSync(options.env.HARNESS_CONTEXT_GENERATION_FILE));
        if (reroute) onEvent({ method: 'model/rerouted', params: { threadId: params.threadId, toModel: 'new-model' } });
        observations.push({ before: before.generation, generation: JSON.parse(fs.readFileSync(options.env.HARNESS_CONTEXT_GENERATION_FILE)).generation,
          budget: fs.readFileSync(options.env.HARNESS_CONTEXT_OUTPUT_BUDGET_FILE, 'utf8') });
        fs.appendFileSync(options.env.HARNESS_CONTEXT_OUTPUT_BUDGET_FILE, 'fixture-reservation 100\n');
        const ack = params.input[0].text.match(/ack must equal ([\w-]+)/)[1];
        turn++;
        const cp = checkpoint(ack, stalled ? 1 : turn, turn >= finishAt ? 'completed' : 'running');
        if (unresolved) cp.unresolved = 'write may still be running';
        onEvent({ method: 'thread/tokenUsage/updated', params: { threadId: params.threadId, tokenUsage: {
          total: { inputTokens: turn * 100, outputTokens: turn * 10 }, last: { inputTokens: 100 }, modelContextWindow: 100 } } });
        onEvent({ method: 'item/completed', params: { threadId: params.threadId, item: { id: 'answer', type: 'agentMessage', text: JSON.stringify(cp) } } });
        if (pendingTools) onEvent({ method: 'item/started', params: { threadId: params.threadId, item: { id: 'write', type: 'commandExecution' } } });
        pending = { method: 'turn/completed', params: { threadId: params.threadId, turn: { id: `turn-${turn}`, status: 'completed' } } };
        return { turn: { id: `turn-${turn}` } };
      }
      throw new Error(`unexpected method ${method}`);
    }, async wait(predicate) { assert.ok(predicate(pending)); return pending; } };
  } };
}

test('runner compacts safely and completes in the original thread', async t => {
  const dir = setup(t); const fake = backend({ finishAt: 2 });
  const state = await runObjective({ project: dir, dir, objective: 'test', permissions: 'no push',
    policy: { ...defaultPolicy, cooldownTurns: 1 }, clientFactory: fake.factory });
  assert.equal(state.phase, 'completed');
  const calls = fake.requests;
  assert.deepEqual(calls.map(c => c.method), ['thread/start', 'turn/start', 'thread/compact/start', 'turn/start']);
  assert.ok(calls[1].params.input[0].text.includes('no push'));
  assert.equal(calls.some(c => /resume|fork/.test(c.method)), false);
  assert.equal(fs.existsSync(path.join(dir, 'lease.json')), false);
  assert.equal(fs.existsSync(path.join(dir, 'generation.json')), false);
  assert.equal(fs.existsSync(path.join(dir, 'output-budget.log')), false);
  assert.deepEqual(fake.observations.map(value => value.budget), ['', '']);
  assert.ok(fake.observations[1].generation > fake.observations[0].generation);
});

test('native model rerouting invalidates the runner generation', async t => {
  const dir = setup(t); const fake = backend({ finishAt: 1, reroute: true });
  await runObjective({ project: dir, dir, objective: 'test', permissions: 'no push', clientFactory: fake.factory });
  assert.equal(fake.observations[0].generation, fake.observations[0].before + 1);
});

test('context pressure after compaction saves a checkpoint for manual continuation without starting another thread', async t => {
  const dir = setup(t); const fake = backend();
  const state = await runObjective({ project: dir, dir, objective: 'test', permissions: 'no push',
    policy: { ...defaultPolicy, cooldownTurns: 1 }, clientFactory: fake.factory });

  assert.equal(state.phase, 'manual-handoff');
  assert.deepEqual(state.threads, ['thread-1']);
  assert.deepEqual(fake.requests.map(c => c.method), ['thread/start', 'turn/start', 'thread/compact/start', 'turn/start']);
  const saved = JSON.parse(fs.readFileSync(path.join(dir, 'checkpoint.json')));
  assert.equal(saved.checkpoint.completedSteps, 2);
  assert.equal(saved.objective, 'test');
  assert.equal(saved.permissions, 'no push');
  assert.equal(saved.thread, 'thread-1');
  assert.equal(fs.existsSync(path.join(dir, 'lease.json')), false);
});

test('uncertain operations stop maintenance; no-progress and turn budgets stop loops', async t => {
  for (const [options, expected, policy] of [[{ unresolved: true }, 'blocked', defaultPolicy],
    [{ stalled: true, finishAt: 99 }, 'stalled', defaultPolicy],
    [{ finishAt: 99 }, 'budget', { ...defaultPolicy, maxTurns: 2, cooldownTurns: 1 }]]) {
    const dir = path.join(setup(t), 'run'); const fake = backend(options);
    const state = await runObjective({ project: path.dirname(dir), dir, objective: 'test', permissions: 'no push', policy, clientFactory: fake.factory });
    assert.equal(state.phase, expected); assert.ok(state.turns <= 2);
    if (options.unresolved) assert.equal(fake.requests.some(c => c.method.includes('compact')), false);
  }
});

test('crash preserves checkpoint state and refuses automatic replay', async t => {
  const dir = setup(t); const fake = backend({ crash: true });
  const options = { project: dir, dir, objective: 'test', permissions: 'no push', clientFactory: fake.factory };
  await assert.rejects(runObjective(options), /transport closed/);
  const state = JSON.parse(fs.readFileSync(path.join(dir, 'state.json')));
  assert.equal(state.phase, 'recovery-required'); assert.equal(state.errorClass, 'uncertain-write');
  await assert.rejects(runObjective(options), /Unfinished prior run/);
  assert.equal(fake.requests.filter(c => c.method === 'turn/start').length, 1);
});

test('pending native tools prohibit checkpoint acceptance and compaction', async t => {
  const dir = setup(t); const fake = backend({ pendingTools: true });
  await assert.rejects(runObjective({ project: dir, dir, objective: 'test', permissions: 'no push', clientFactory: fake.factory }), /not safely completed/);
  assert.equal(fake.requests.some(c => c.method.includes('compact')), false);
  assert.equal(fs.existsSync(path.join(dir, 'checkpoint.json')), false);
});

test('checkpoint acknowledgement, safety and engineering policy are validated', () => {
  assert.throws(() => validateCheckpoint(checkpoint('wrong', 1), 'right'), /Invalid/);
  assert.throws(() => validateCheckpoint({ ...checkpoint('a', 1, 'completed'), unresolved: 'pending' }, 'a'), /Invalid/);
  assert.throws(() => policyFor({ contextRatio: 1.1 }), /Invalid/);
  assert.throws(() => policyFor({ maxTurns: 0 }), /Invalid/);
  assert.throws(() => policyFor({ cooldownTurns: 1.5 }), /Invalid/);
  assert.throws(() => policyFor({ maxRotations: 2 }), /Unknown/);
  const state = { checkpoint: checkpoint('a', 1), usage: { context: 90, contextWindow: 100 }, progress: true,
    started: Date.now(), turns: 1, lastMaintenance: 0, compacted: false };
  assert.equal(chooseAction(state, defaultPolicy), 'continue');
  assert.equal(chooseAction({ ...state, turns: 2 }, defaultPolicy), 'compact');
  assert.equal(chooseAction({ ...state, turns: 2, compacted: true }, defaultPolicy), 'manual-handoff');
});

test('MCP environment overrides reach only configured proxy servers without changing model or user config', () => {
  const args = mcpEnvironmentOverrides([
    { name: 'tokensave', enabled: true, transport: { type: 'stdio', command: 'node', args: ['/hooks/mcp-proxy.mjs'] } },
    { name: 'custom', enabled: true, transport: { type: 'stdio', command: 'custom' } },
  ], { HARNESS_CONTEXT_GENERATION_FILE: '/private/generation.json', HARNESS_CONTEXT_OUTPUT_BUDGET_FILE: '/private/budget.log' });
  assert.deepEqual(args, ['-c', 'mcp_servers.tokensave.env.HARNESS_CONTEXT_GENERATION_FILE="/private/generation.json"',
    '-c', 'mcp_servers.tokensave.env.HARNESS_CONTEXT_OUTPUT_BUDGET_FILE="/private/budget.log"']);
});

test('stdio client handles completion arriving before request acknowledgement', async () => {
  const script = `const r=require('node:readline').createInterface({input:process.stdin});r.on('line',line=>{const m=JSON.parse(line);if(m.id){console.log(JSON.stringify({method:'turn/completed',params:{threadId:'a',turn:{id:'b',status:'completed'}}}));console.log(JSON.stringify({id:m.id,result:{ok:true}}))}})`;
  const client = new AppServer({ command: process.execPath, args: ['-e', script] });
  try {
    assert.deepEqual(await client.request('test', {}), { ok: true });
    const event = await client.wait(e => e.params.turn.id === 'b', 1000);
    assert.equal(event.params.threadId, 'a');
  } finally { client.close(); }
});
