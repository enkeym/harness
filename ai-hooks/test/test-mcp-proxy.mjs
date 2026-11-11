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

function client(t, { lazy = false, playwright = false, existingTabsOnly = false, extension = false, token = true, protocol, policy = {}, stubborn = false, descendant = false, breakOnce = false, name, resources = false, onRequest } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-proxy-'));
  const starts = path.join(dir, 'starts');
  const catalog = path.join(dir, 'catalog.json');
  const policyFile = path.join(dir, 'policy.json');
  fs.writeFileSync(policyFile, JSON.stringify(policy));
  const tools = playwright
    ? JSON.parse(fs.readFileSync(path.resolve(here, '../../mcp/playwright-tools.json'), 'utf8')).tools.filter(tool => ['browser_tabs', 'browser_click', 'browser_take_screenshot', 'browser_evaluate'].includes(tool.name))
    : [{ name: 'read', description: 'Cached description', inputSchema: { type: 'object' } }];
  const backendArgs = extension ? [backend, '--extension'] : [backend];
  fs.writeFileSync(catalog, JSON.stringify({ command: process.execPath, args: backendArgs, initialize, tools }));
  const p = spawn(process.execPath, [proxy, ...(lazy ? ['--catalog', catalog, ...(playwright ? ['--playwright-compat'] : []), ...(existingTabsOnly ? ['--existing-tabs-only'] : [])] : ['--compact']), '--', process.execPath, ...backendArgs], {
    env: { ...process.env, PLAYWRIGHT_MCP_EXTENSION_TOKEN: token ? 'test-token' : '', HARNESS_MCP_POLICY_FILE: policyFile, FAKE_MCP_STARTS: starts, FAKE_MCP_STUBBORN: stubborn ? '1' : '', FAKE_MCP_DESCENDANT: descendant ? '1' : '', FAKE_MCP_BREAK_ONCE: breakOnce ? '1' : '', FAKE_MCP_NAME: name ?? '', FAKE_MCP_RESOURCES: resources ? '1' : '', ...(protocol ? { FAKE_MCP_PROTOCOL: protocol } : {}) }, stdio: ['pipe', 'pipe', 'pipe'],
  });
  const pending = new Map();
  const notifications = [];
  const messages = [];
  let nextId = 0;
  let stderr = '';
  p.stderr.on('data', (data) => { stderr += data; });
  createInterface({ input: p.stdout }).on('line', (line) => {
    const message = JSON.parse(line);
    if (message.method) {
      notifications.push(message);
      if (Object.hasOwn(message, 'id') && onRequest) send({ id: message.id, ...onRequest(message) });
      return;
    }
    messages.push(message);
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
  function send(message) {
    p.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
  }
  function rpc(method, params = {}, requestId) {
    const id = requestId ?? ++nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`No response to ${method}: ${stderr}`)); }, 3000);
      pending.set(id, (message) => { clearTimeout(timer); resolve(message); });
      send({ id, method, params });
    });
  }
  return { rpc, send, starts, notifications, messages, exited, p };
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

for (const lazy of [false, true]) {
  test(`backend requests receive client results and errors (${lazy ? 'lazy' : 'compact'})`, async t => {
    const roots = { roots: [{ uri: 'file:///workspace', name: 'workspace' }] };
    const error = { code: -32601, message: 'Roots unavailable' };
    let response = { result: roots };
    const c = client(t, { lazy, onRequest: request => {
      assert.equal(request.method, 'roots/list');
      return response;
    } });
    await c.rpc('initialize', initialize);

    const success = await c.rpc('tools/call', { name: 'request_roots' });
    assert.deepEqual(JSON.parse(success.result.content[0].text), roots);
    response = { error };
    const failure = await c.rpc('tools/call', { name: 'request_roots' });
    assert.deepEqual(JSON.parse(failure.result.content[0].text), error);
  });
}

test('Playwright starts on the first browser call, reuses attached tabs and accepts common browser call forms', async t => {
  const c = client(t, { lazy: true, playwright: true, existingTabsOnly: true });
  await c.rpc('initialize', initialize);
  const listed = (await c.rpc('tools/list')).result.tools;
  const schema = name => listed.find(tool => tool.name === name).inputSchema;
  assert.ok(!schema('browser_tabs').required.includes('action'));
  assert.ok(!schema('browser_tabs').properties.action.enum.includes('new'));
  assert.deepEqual(schema('browser_click').anyOf, [{ required: ['target'] }, { required: ['ref'] }]);
  assert.deepEqual(schema('browser_evaluate').anyOf, [{ required: ['function'] }, { required: ['expression'] }]);
  assert.ok(!schema('browser_take_screenshot').required.includes('scale'));

  assert.equal(fs.existsSync(c.starts), false);

  for (const [name, input, expected] of [
    ['browser_tabs', {}, { action: 'list' }],
    ['browser_click', { ref: 'e131', element: 'button' }, { target: 'e131', element: 'button' }],
    ['browser_take_screenshot', {}, { scale: 'css' }],
    ['browser_evaluate', { expression: '1 + 1' }, { function: '() => (1 + 1)' }],
  ]) {
    const response = await c.rpc('tools/call', { name, arguments: input });
    assert.deepEqual(response.result.structuredContent.arguments, expected);
    assert.equal(response.result.structuredContent.tokenPresent, true);
  }
  const blocked = await c.rpc('tools/call', { name: 'browser_tabs', arguments: { action: 'new', url: 'http://localhost:5173/' } });
  assert.equal(blocked.error.code, -32602);
  assert.match(blocked.error.message, /New tabs are disabled/);
  assert.equal(fs.readFileSync(c.starts, 'utf8'), 'start\n');
});

test('Playwright browser calls fail fast without the extension token instead of waiting', async t => {
  const c = client(t, { lazy: true, playwright: true, extension: true, token: false });
  await c.rpc('initialize', initialize);
  const response = await c.rpc('tools/call', { name: 'browser_tabs', arguments: {} });
  assert.equal(response.error.code, -32603);
  assert.match(response.error.message, /PLAYWRIGHT_MCP_EXTENSION_TOKEN/);
  assert.equal(fs.existsSync(c.starts), false);
});

test('tokensave symbol tools accept name and id aliases', async (t) => {
  const c = client(t);
  await c.rpc('initialize', initialize);
  for (const [name, input, expected] of [
    ['tokensave_body', { name: '_clash' }, { symbol: '_clash' }],
    ['tokensave_callers', { id: 'method:1' }, { node_id: 'method:1' }],
    ['tokensave_callees', { name: '_clash', id: 'method:1' }, { symbol: '_clash', node_id: 'method:1' }],
    ['tokensave_impact', { symbol: 'Tunnel::_clash', name: 'ignored', node_id: 'method:1' }, { symbol: 'Tunnel::_clash', node_id: 'method:1' }],
    ['tokensave_similar', { name: '_clash' }, { symbol: '_clash' }],
    ['tokensave_signature', { id: 'method:1' }, { node_id: 'method:1' }],
    ['tokensave_search', { name: 'keep' }, { name: 'keep' }],
    ['tokensave_find_exact_symbol', { name: '_clash' }, { name: '_clash' }],
  ]) {
    const response = await c.rpc('tools/call', { name, arguments: input });
    assert.deepEqual(response.result.structuredContent.arguments, expected);
  }
  const read = await c.rpc('tools/call', { name: 'read', arguments: { name: '_clash' } });
  assert.deepEqual(read.result.structuredContent, { distinctMetadata: 42 });
});

test('tokensave_read accepts comma-separated and spaced line ranges', async (t) => {
  const c = client(t);
  await c.rpc('initialize', initialize);
  for (const [lines, expected] of [
    ['590,615', '590-615'],
    ['590, 615', '590-615'],
    ['590 615', '590-615'],
    ['590;615', '590-615'],
    [' 590,615 ', '590-615'],
    ['590-615', '590-615'],
    ['590', '590'],
    ['590615', '590615'],
  ]) {
    const response = await c.rpc('tools/call', { name: 'tokensave_read', arguments: { file: 'a.mjs', mode: 'lines', lines } });
    assert.equal(response.result.structuredContent.arguments.lines, expected);
  }
  const untouched = await c.rpc('tools/call', { name: 'tokensave_search', arguments: { query: 'a', lines: '590,615' } });
  assert.equal(untouched.result.structuredContent.arguments.lines, '590,615');
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
  assert.deepEqual((await c.rpc('initialize', initialize)).result, initialize, 'shared instructions must not be repeated per tool');
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

test('tokensave stops advertising resources so no client asks for templates', async t => {
  const c = client(t, { name: 'tokensave', resources: true });
  const init = await c.rpc('initialize', initialize);
  assert.equal(init.result.capabilities.resources, undefined);
  assert.deepEqual(init.result.capabilities.tools, { listChanged: true });
});

test('other backends keep the resources they advertise', async t => {
  const c = client(t, { resources: true });
  const init = await c.rpc('initialize', initialize);
  assert.deepEqual(init.result.capabilities.resources, {});
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

test('catalog mode reports a request timeout and keeps serving after a backend restart', async t => {
  const c = client(t, { lazy: true, policy: { requestTimeoutMs: 200, shutdownGraceMs: 20 } });
  const init = await c.rpc('initialize', initialize);
  assert.equal(init.result.protocolVersion, initialize.protocolVersion);

  const hung = await c.rpc('tools/call', { name: 'hang' });
  assert.equal(hung.error.code, -32603);
  assert.match(hung.error.message, /timed out; completion unknown/);
  assert.equal(c.p.exitCode, null);

  assert.deepEqual((await c.rpc('ping')).result, {});

  const call = await c.rpc('tools/call', { name: 'read' });
  assert.equal(call.error, undefined);
  assert.equal(call.result.content[0].text, 'file content once');
  assert.equal(fs.readFileSync(c.starts, 'utf8'), 'start\nstart\n');
});

test('catalog mode recovers from a broken backend pipe without replaying the pending call', async t => {
  const c = client(t, { lazy: true, breakOnce: true, policy: { requestTimeoutMs: 1000, shutdownGraceMs: 20 } });
  await c.rpc('initialize', initialize);
  const listed = (await c.rpc('tools/list')).result.tools;
  const failed = c.rpc('tools/call', { name: 'break' });
  const deadline = Date.now() + 1000;
  while (!c.notifications.some(message => message.method === 'test/pipe_closed') && Date.now() < deadline)
    await new Promise(resolve => setTimeout(resolve, 10));
  assert.ok(c.notifications.some(message => message.method === 'test/pipe_closed'));
  c.send({ id: 'trigger', method: 'tools/call', params: { name: 'read' } });
  const response = await failed;
  assert.equal(response.error.code, -32603);
  assert.match(response.error.message, /EPIPE|ECONNRESET|broken pipe/i);
  assert.deepEqual((await c.rpc('tools/list')).result.tools, listed);
  assert.equal((await c.rpc('tools/call', { name: 'read' })).result.content[0].text, 'file content once');
  assert.equal(fs.readFileSync(c.starts, 'utf8'), 'start\nstart\n');
});

test('a cancelled request is dropped and forwarded instead of timing out the backend', async t => {
  const c = client(t, { lazy: true, policy: { requestTimeoutMs: 150, shutdownGraceMs: 20 } });
  await c.rpc('initialize', initialize);
  assert.equal((await c.rpc('tools/call', { name: 'read' })).result.content[0].text, 'file content once');

  c.send({ id: 'hang', method: 'tools/call', params: { name: 'hang' } });
  await new Promise((resolve) => setTimeout(resolve, 50));
  c.send({ method: 'notifications/cancelled', params: { requestId: 'hang' } });
  await new Promise((resolve) => setTimeout(resolve, 300));

  assert.equal(c.messages.filter((message) => message.id === 'hang').length, 0);
  assert.ok(c.notifications.some((message) => message.method === 'test/cancelled'));
  assert.equal(fs.readFileSync(c.starts, 'utf8'), 'start\n');
  assert.equal(c.p.exitCode, null);

  const call = await c.rpc('tools/call', { name: 'read' });
  assert.equal(call.error, undefined);
  assert.equal(call.result.content[0].text, 'file content once');
  assert.equal(fs.readFileSync(c.starts, 'utf8'), 'start\n');
});
