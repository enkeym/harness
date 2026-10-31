import './env-isolate.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Accounting, ReadLedger, acquireLease, atomicJson, ingestRollout, safeRead, classify, boundTextResult, utf8Prefix, redactDiagnostic } from '../bin/context-state.mjs';

function temporary(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'context-state-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return dir;
}
const usage = (input, output = 10) => ({ inputTokens: input, cachedInputTokens: input / 2, outputTokens: output, reasoningOutputTokens: 2 });

test('diagnostics redact recognizable credentials without modifying tool results', () => {
  assert.equal(redactDiagnostic('Bearer fixture-value api_key=fixture-value password: fixture-value'),
    'Bearer [redacted] api_key=[redacted] password: [redacted]');
});

test('installed native and rollout fixtures preserve post-compaction context without double billing', () => {
  const fixture = JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures/context-usage.json')));
  const native = new Accounting(); for (const event of fixture.native) native.event(event);
  assert.equal(native.state.input, 15566); assert.equal(native.state.output, 15);
  assert.equal(native.state.context, 19443); assert.equal(native.state.contextWindow, 475000);
  const rollout = new Accounting(); rollout.event(fixture.rollout); rollout.event(fixture.rollout);
  assert.equal(rollout.state.input, 15783); assert.equal(rollout.state.cachedInput, 12032);
});

test('cumulative usage is counted once, reasoning stays a subset, reset starts a segment', () => {
  const a = new Accounting();
  a.usage('a', usage(100), usage(100), 200000);
  a.usage('a', usage(100), usage(100), 200000);
  a.usage('a', usage(200, 20), usage(100), 200000);
  assert.equal(a.state.input, 200); assert.equal(a.state.output, 20);
  a.usage('a', usage(20, 5), usage(20), 200000);
  assert.equal(a.state.input, 220); assert.equal(a.state.cachedInput, 110);
  assert.equal(a.state.output, 25); assert.equal(a.state.money, null);
});

test('rollout cursor survives partial UTF-8 lines, restart, truncation and duplicate records', t => {
  const file = path.join(temporary(t), 'rollout.jsonl');
  const record = JSON.stringify({ type: 'event_msg', payload: { type: 'token_count', info: {
    total_token_usage: { input_tokens: 100, cached_input_tokens: 40, output_tokens: 5 },
    last_token_usage: { input_tokens: 100 }, model_context_window: 200000 } } });
  fs.writeFileSync(file, record + '\n' + '{"тест":');
  let a = new Accounting(); let cursor = ingestRollout(file, {}, a);
  assert.equal(a.state.input, 100); assert.equal(cursor.offset, Buffer.byteLength(record + '\n'));
  a = new Accounting(a.state); fs.appendFileSync(file, '"да"}\n' + record + '\n');
  cursor = ingestRollout(file, cursor, a); assert.equal(a.state.input, 100);
  fs.writeFileSync(file, record + '\n'); cursor = ingestRollout(file, cursor, a);
  assert.equal(cursor.offset, Buffer.byteLength(record + '\n')); assert.equal(a.state.input, 100);
  a.event({ type: 'event_msg', payload: { type: 'token_usage_record', input_tokens: 999 } });
  assert.equal(a.state.input, 100);
});

test('read digests require content held in this generation and identity', t => {
  const project = temporary(t); const ledger = new ReadLedger(1);
  const input = { project, file: 'a', range: '1-2', digest: 'one', backend: 'v1', branch: 'main' };
  assert.equal(ledger.remember(input), false); assert.equal(ledger.remember(input), true);
  assert.equal(ledger.digest({ ...input, digest: 'two' }), undefined);
  assert.equal(ledger.digest({ ...input, backend: 'v2' }), undefined);
  ledger.invalidate(2); assert.equal(ledger.digest(input), undefined);
});

test('checkpoint writes are private and leases never steal stale/active ownership', t => {
  const dir = temporary(t); const file = path.join(dir, 'checkpoint.json');
  atomicJson(file, { next: 'one' }); atomicJson(file, { next: 'two' });
  assert.deepEqual(JSON.parse(fs.readFileSync(file)), { next: 'two' });
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  const release = acquireLease(dir); assert.throws(() => acquireLease(dir), /EEXIST/);
  release(); fs.writeFileSync(path.join(dir, 'lease.json'), '{"pid":99999999}');
  assert.throws(() => acquireLease(dir), /EEXIST/);
});

test('only temporary explicitly read-only operations retry; writes remain uncertain', async () => {
  let attempts = 0;
  await assert.rejects(safeRead(async () => { attempts++; throw new Error('ECONNRESET'); }, { readOnly: true, sleep: async () => {} }));
  assert.equal(attempts, 3);
  attempts = 0;
  await assert.rejects(safeRead(async () => { attempts++; throw new Error('ECONNRESET'); }));
  assert.equal(attempts, 1); assert.equal(classify('anything', true), 'uncertain-write');
  attempts = 0;
  await assert.rejects(safeRead(async () => { attempts++; throw new Error('invalid argument'); }, { readOnly: true }));
  assert.equal(attempts, 1);
});

test('text output obeys aggregate UTF-8 budget and preserves protocol payloads', t => {
  const dir = temporary(t);
  const result = { content: [{ type: 'text', text: 'я'.repeat(1000) }, { type: 'text', text: '😀'.repeat(1000) }] };
  const bounded = boundTextResult(result, 512, dir);
  assert.ok(bounded.content.reduce((n, b) => n + Buffer.byteLength(b.text), 0) <= 512);
  assert.ok(!JSON.stringify(bounded).includes('�'));
  const artifact = fs.readdirSync(dir)[0]; assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, artifact))), result);
  for (const original of [{ ...result, isError: true }, { ...result, structuredContent: { test: 1 } },
    { content: [{ type: 'text', text: JSON.stringify({ large: 'a'.repeat(1000) }) }] },
    { content: [{ type: 'image', data: 'abc', mimeType: 'image/png' }] }]) assert.equal(boundTextResult(original, 512, dir), original);
  assert.equal(utf8Prefix('я😀!', 5), 'я');
});
