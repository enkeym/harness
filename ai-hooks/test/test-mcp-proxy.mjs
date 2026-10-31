import './env-isolate.mjs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const proxy = path.resolve(here, '../bin/mcp-proxy.mjs');
const backend = path.join(here, 'fixtures/fake-mcp.mjs');
const initialize = { protocolVersion: '2024-11-05', capabilities: { tools: { listChanged: true } }, serverInfo: { name: 'fake', version: '1' } };

function client(t, { lazy = false, protocol, policy = {}, stubborn = false, descendant = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-proxy-'));
  const starts = path.join(dir, 'starts');
  const catalog = path.join(dir, 'catalog.json');
  const policyFile = path.join(dir, 'policy.json');
  fs.writeFileSync(policyFile, JSON.stringify(policy));
  fs.writeFileSync(catalog, JSON.stringify({ command: process.execPath, args: [backend], initialize, tools: [{ name: 'read', description: 'Cached description', inputSchema: { type: 'object' } }] }));
  const p = spawn(process.execPath, [proxy, ...(lazy ? ['--catalog', catalog] : ['--compact']), '--', process.execPath, backend], {
    env: { ...process.env, HARNESS_MCP_POLICY_FILE: policyFile, FAKE_MCP_STARTS: starts, FAKE_MCP_STUBBORN: stubborn ? '1' : '', FAKE_MCP_DESCENDANT: descendant ? '1' : '', ...(protocol ? { FAKE_MCP_PROTOCOL: protocol } : {}) }, stdio: ['pipe', 'pipe', 'pipe'],
  });
  const pending = new Map();
  const notifications = [];
  let nextId = 0;
  let stderr = '';
  p.stderr.on('data', (data) => { stderr += data; });
  createInterface({ input: p.stdout }).on('line', (line) => {
    const message = JSON.parse(line);
    if (message.method) { notifications.push(message); return; }
    pending.get(message.id)?.(message);
    pending.delete(message.id);
  });
  const exited = new Promise((resolve) => p.on('close', resolve));
  t.after(async () => {
    p.stdin.end();
    const timer = setTimeout(() => p.kill('SIGKILL'), 2000);
    await exited;
    clearTimeout(timer);
    fs.rmSync(dir, { recursive: true, force: true });
  });
  function rpc(method, params = {}, requestId) {
    const id = requestId ?? ++nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`No response to ${method}: ${stderr}`)); }, 3000);
      pending.set(id, (message) => { clearTimeout(timer); resolve(message); });
      p.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  }
  return { rpc, starts, notifications, exited, p };
}

test('catalog discovery and ping do not launch the lazy backend; concurrent calls launch it once', async (t) => {
  const c = client(t, { lazy: true });
  assert.deepEqual((await c.rpc('initialize', initialize)).result, initialize);
  assert.equal((await c.rpc('tools/list')).result.tools[0].description, 'Cached description');
  assert.deepEqual((await c.rpc('ping')).result, {});
  assert.equal(fs.existsSync(c.starts), false);
  const results = await Promise.all([c.rpc('tools/call', { name: 'read' }), c.rpc('tools/call', { name: 'read' })]);
  assert.equal(fs.readFileSync(c.starts, 'utf8'), 'start\n');
  for (const response of results) assert.equal(response.result.content[0].text, 'file content once');
});

test('a newer client uses the catalog protocol when the lazy backend starts', async (t) => {
  const c = client(t, { lazy: true });
  const response = await c.rpc('initialize', {
    protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'modern-client', version: '1' },
  });
  assert.equal(response.result.protocolVersion, initialize.protocolVersion);
  assert.equal(fs.existsSync(c.starts), false);

  const call = await c.rpc('tools/call', { name: 'read' });
  assert.equal(call.error, undefined);
  assert.equal(call.result.content[0].text, 'file content once');
});

test('compact catalogs preserve schemas, dynamic discovery, errors and complete call results', async (t) => {
  const c = client(t);
  assert.deepEqual((await c.rpc('initialize', initialize)).result, initialize, 'shared instructions must not be repeated by Codex per tool');
  const list = (await c.rpc('tools/list')).result;
  assert.deepEqual(list.tools.filter(tool => tool.name !== 'harness_read_result'), [{ name: 'read', description: 'Read a bounded range.', inputSchema: { type: 'object' }, annotations: { readOnlyHint: true } }]);
  assert.equal(list.tools.find(tool => tool.name === 'harness_read_result').annotations.readOnlyHint, true);
  const result = (await c.rpc('tools/call', { name: 'more' })).result;
  assert.deepEqual(result, { content: [{ type: 'text', text: 'file content once' }], structuredContent: { distinctMetadata: 42 }, isError: false });
  assert.equal(c.notifications[0].method, 'notifications/tools/list_changed');
  assert.deepEqual((await c.rpc('tools/list')).result, list);
  assert.deepEqual((await c.rpc('tools/call', { name: 'fail' })).error, { code: -32602, message: 'bad arguments' });
});

test('a lazy backend protocol mismatch returns an error instead of silently using stale metadata', async (t) => {
  const c = client(t, { lazy: true, protocol: 'changed' });
  await c.rpc('initialize', initialize);
  const response = await c.rpc('tools/call', { name: 'read' });
  assert.equal(response.error.code, -32603);
  assert.match(response.error.message, /protocol changed/);
  assert.equal(await c.exited, 1);
});

test('direct mode negotiates the backend protocol and preserves prompts, resources and mixed RPC ids', async t => {
  const c = client(t, { protocol: '2025-11-25' });
  const init = await c.rpc('initialize', { ...initialize, protocolVersion: '2025-11-25' }, 'init');
  assert.equal(init.id, 'init');
  assert.equal(init.result.protocolVersion, '2025-11-25');
  const [prompts, resources] = await Promise.all([c.rpc('prompts/list', {}, 0), c.rpc('resources/list', {}, 'resources')]);
  assert.equal(prompts.id, 0); assert.deepEqual(prompts.result, { prompts: [] });
  assert.equal(resources.id, 'resources'); assert.deepEqual(resources.result, { resources: [] });
});

test('a hung backend fails pending requests and exits without replaying operations', async t => {
  const c = client(t, { stubborn: true, descendant: true, policy: { requestTimeoutMs: 200, shutdownGraceMs: 20 } });
  await c.rpc('initialize', initialize);
  const results = await Promise.all([
    c.rpc('tools/call', { name: 'hang' }),
    c.rpc('tools/call', { name: 'hang' }),
  ]);
  for (const response of results) {
    assert.equal(response.error.code, -32603);
    assert.match(response.error.message, /timed out; completion unknown/);
  }
  assert.equal(await c.exited, 1);
  assert.ok(c.notifications.some(message => message.method === 'test/descendant'));
  assert.equal(fs.readFileSync(c.starts, 'utf8'), 'start\n');
});
