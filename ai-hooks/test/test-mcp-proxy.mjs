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

function client(t, { lazy = false, playwright = false, extension = false, token = true, protocol, policy = {}, stubborn = false, descendant = false, breakOnce = false, name, resources = false, onRequest, handshakeDelayMs = 0, recordCalls = false, environment = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-proxy-'));
  const starts = path.join(dir, 'starts');
  const calls = recordCalls ? path.join(dir, 'calls') : undefined;
  const catalog = path.join(dir, 'catalog.json');
  const policyFile = path.join(dir, 'policy.json');
  fs.writeFileSync(policyFile, JSON.stringify(policy));
  const tools = playwright
    ? JSON.parse(fs.readFileSync(path.resolve(here, '../../mcp/playwright-tools.json'), 'utf8')).tools.filter(tool => ['browser_tabs', 'browser_click', 'browser_take_screenshot', 'browser_evaluate'].includes(tool.name))
    : [{ name: 'read', description: 'Cached description', inputSchema: { type: 'object' } }];
  const backendArgs = extension ? [backend, '--extension'] : [backend];
  fs.writeFileSync(catalog, JSON.stringify({ command: process.execPath, args: backendArgs, initialize, tools }));
  const p = spawn(process.execPath, [proxy, ...(lazy ? ['--catalog', catalog, ...(playwright ? ['--playwright-compat'] : [])] : ['--compact']), '--', process.execPath, ...backendArgs], {
    env: { ...process.env, PLAYWRIGHT_MCP_EXTENSION_TOKEN: token ? 'test-token' : '', HARNESS_MCP_POLICY_FILE: policyFile, FAKE_MCP_STARTS: starts, FAKE_MCP_STUBBORN: stubborn ? '1' : '', FAKE_MCP_DESCENDANT: descendant ? '1' : '', FAKE_MCP_BREAK_ONCE: breakOnce ? '1' : '', FAKE_MCP_NAME: name ?? '', FAKE_MCP_RESOURCES: resources ? '1' : '', FAKE_MCP_HANDSHAKE_DELAY_MS: String(handshakeDelayMs), ...(calls ? { FAKE_MCP_CALLS: calls } : {}), ...(protocol ? { FAKE_MCP_PROTOCOL: protocol } : {}), ...environment }, stdio: ['pipe', 'pipe', 'pipe'],
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
  return { rpc, send, starts, calls, notifications, messages, exited, p };
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
  const c = client(t, { lazy: true, playwright: true });
  await c.rpc('initialize', initialize);
  const listed = (await c.rpc('tools/list')).result.tools;
  const schema = name => listed.find(tool => tool.name === name).inputSchema;
  assert.ok(!schema('browser_tabs').required.includes('action'));
  assert.ok(schema('browser_tabs').properties.action.enum.includes('new'));
  assert.deepEqual(schema('browser_click').anyOf, [{ required: ['target'] }, { required: ['ref'] }]);
  assert.deepEqual(schema('browser_evaluate').anyOf, [{ required: ['function'] }, { required: ['expression'] }]);
  assert.ok(!schema('browser_take_screenshot').required.includes('scale'));

  assert.equal(fs.existsSync(c.starts), false);

  for (const [name, input, expected] of [
    ['browser_tabs', {}, { action: 'list' }],
    ['browser_tabs', { action: 'select', index: 1 }, { action: 'select', index: 1 }],
    ['browser_tabs', { action: 'new', url: 'http://localhost:5173/' }, { action: 'new', url: 'http://localhost:5173/' }],
    ['browser_click', { ref: 'e131', element: 'button' }, { target: 'e131', element: 'button' }],
    ['browser_take_screenshot', {}, { scale: 'css' }],
    ['browser_evaluate', { expression: '1 + 1' }, { function: '() => (1 + 1)' }],
  ]) {
    const response = await c.rpc('tools/call', { name, arguments: input });
    assert.deepEqual(response.result.structuredContent.arguments, expected);
    assert.equal(response.result.structuredContent.tokenPresent, true);
  }
  assert.equal(fs.readFileSync(c.starts, 'utf8'), 'start\n');
});

test('browser_tabs rejects a url without action or with an incompatible explicit action', async t => {
  const c = client(t, { lazy: true, playwright: true });
  await c.rpc('initialize', initialize);
  for (const input of [
    { url: 'http://127.0.0.1:5173/start' },
    { action: 'list', url: 'http://127.0.0.1:5173/start' },
    { action: 'select', index: 1, url: 'http://127.0.0.1:5173/start' },
    { action: 'close', url: 'http://127.0.0.1:5173/start' },
  ]) {
    const response = await c.rpc('tools/call', { name: 'browser_tabs', arguments: input });
    assert.equal(response.error?.code, -32602, JSON.stringify(input));
    assert.match(response.error?.message ?? '', /action "new"/, JSON.stringify(input));
    assert.equal(response.result, undefined, JSON.stringify(input));
  }
  assert.equal(fs.existsSync(c.starts), false);
});

test('browser_tabs rejects empty, whitespace and non-string new urls before starting the backend', async t => {
  const c = client(t, { lazy: true, playwright: true });
  await c.rpc('initialize', initialize);
  for (const url of ['', '   ', null, 42, {}]) {
    const response = await c.rpc('tools/call', { name: 'browser_tabs', arguments: { action: 'new', url } });
    assert.equal(response.error?.code, -32602, JSON.stringify(url));
    assert.match(response.error?.message ?? '', /url/i, JSON.stringify(url));
    assert.equal(response.result, undefined, JSON.stringify(url));
  }
  assert.equal(fs.existsSync(c.starts), false);
});

test('browser_tabs url misuse is not dispatched to an already running backend', async t => {
  const c = client(t, { lazy: true, playwright: true, recordCalls: true });
  await c.rpc('initialize', initialize);
  assert.equal((await c.rpc('tools/call', { name: 'browser_tabs' })).error, undefined);
  const before = fs.readFileSync(c.calls, 'utf8');
  const response = await c.rpc('tools/call', { name: 'browser_tabs', arguments: { action: 'list', url: 'http://127.0.0.1:5173/' } });
  assert.equal(response.error?.code, -32602);
  assert.equal(fs.readFileSync(c.calls, 'utf8'), before);
  assert.equal(fs.readFileSync(c.starts, 'utf8'), 'start\n');
});

test('browser_tabs defaults to list and forwards explicit operations and known urls unchanged', async t => {
  const c = client(t, { lazy: true, playwright: true, recordCalls: true });
  await c.rpc('initialize', initialize);
  for (const [params, expected] of [
    [{ name: 'browser_tabs' }, { action: 'list' }],
    [{ name: 'browser_tabs', arguments: {} }, { action: 'list' }],
    [{ name: 'browser_tabs', arguments: { action: 'list' } }, { action: 'list' }],
    [{ name: 'browser_tabs', arguments: { action: 'select', index: 1 } }, { action: 'select', index: 1 }],
    [{ name: 'browser_tabs', arguments: { action: 'close', index: 2 } }, { action: 'close', index: 2 }],
    [{ name: 'browser_tabs', arguments: { action: 'new', url: 'http://127.0.0.1:5173/start?x=1#frag' } }, { action: 'new', url: 'http://127.0.0.1:5173/start?x=1#frag' }],
    [{ name: 'browser_tabs', arguments: { action: 'new', url: 'http://localhost:5173/' } }, { action: 'new', url: 'http://localhost:5173/' }],
    [{ name: 'browser_tabs', arguments: { action: 'new', url: 'about:blank' } }, { action: 'new', url: 'about:blank' }],
  ]) {
    const response = await c.rpc('tools/call', params);
    assert.deepEqual(response.result.structuredContent.arguments, expected);
    assert.deepEqual(response.result.content, [{ type: 'text', text: 'file content once' }]);
  }
  const records = fs.readFileSync(c.calls, 'utf8').trim().split('\n');
  assert.equal(records.length, 8);
  assert.ok(records.every(record => record.endsWith(':browser_tabs')));
  assert.equal(fs.readFileSync(c.starts, 'utf8'), 'start\n');
});

test('browser_tabs new without url keeps the result and adds a hint to that reply only', async t => {
  const c = client(t, { lazy: true, playwright: true, environment: { FAKE_MCP_DELAY_ID: 'slow', FAKE_MCP_DELAY_MS: '120' } });
  await c.rpc('initialize', initialize);
  const slow = c.rpc('tools/call', { name: 'browser_tabs', arguments: { action: 'new' } }, 'slow');
  const fast = c.rpc('tools/call', { name: 'browser_tabs' }, 'fast');
  const fastResponse = await fast;
  assert.deepEqual(fastResponse.result.content, [{ type: 'text', text: 'file content once' }]);
  const response = await slow;
  assert.deepEqual(response.result.structuredContent.arguments, { action: 'new' });
  assert.equal(response.result.structuredContent.distinctMetadata, 42);
  assert.equal(response.result.structuredContent.tokenPresent, true);
  assert.equal(response.result.content[0].text, 'file content once');
  assert.equal(response.result.content.length, 2);
  assert.match(response.result.content[1].text, /browser_navigate/);
  assert.match(response.result.content[1].text, /url/i);
  assert.match(response.result.content[1].text, /Page URL|snapshot/);
  assert.equal(response.result.isError, false);
});

test('browser_tabs new without url does not mask backend errors', async t => {
  const rejected = client(t, { lazy: true, playwright: true, environment: { FAKE_MCP_JSON_ERROR: 'browser_tabs' } });
  await rejected.rpc('initialize', initialize);
  const jsonError = await rejected.rpc('tools/call', { name: 'browser_tabs', arguments: { action: 'new' } });
  assert.deepEqual(jsonError.error, { code: -32602, message: 'backend rejected arguments' });
  assert.equal(jsonError.result, undefined);

  const failed = client(t, { lazy: true, playwright: true, environment: { FAKE_MCP_IS_ERROR: 'browser_tabs' } });
  await failed.rpc('initialize', initialize);
  const toolError = await failed.rpc('tools/call', { name: 'browser_tabs', arguments: { action: 'new' } });
  assert.deepEqual(toolError.result, {
    content: [{ type: 'text', text: 'backend tool failed' }],
    structuredContent: { failure: true },
    isError: true,
  });
});

test('browser_tabs new with url keeps a tool error and adds recovery guidance', async t => {
  const c = client(t, { lazy: true, playwright: true, recordCalls: true, environment: { FAKE_MCP_IS_ERROR: 'browser_tabs' } });
  await c.rpc('initialize', initialize);
  const response = await c.rpc('tools/call', {
    name: 'browser_tabs',
    arguments: { action: 'new', url: 'http://127.0.0.1:5173/start?secret=none' },
  });
  assert.equal(response.error, undefined);
  assert.equal(response.result.isError, true);
  assert.deepEqual(response.result.structuredContent, { failure: true });
  assert.equal(response.result.content.length, 1);
  assert.ok(response.result.content[0].text.startsWith('backend tool failed'));
  assert.match(response.result.content[0].text, /browser_tabs.*list|action "list"/i);
  assert.match(response.result.content[0].text, /browser_navigate/);
  assert.match(response.result.content[0].text, /Page URL|snapshot/);
  assert.doesNotMatch(response.result.content[0].text, /127\.0\.0\.1|5173|secret/);
  assert.equal(fs.readFileSync(c.calls, 'utf8').trim().split('\n').length, 1);
});

test('browser_tabs recovery guidance is limited to tool errors on new with url', async t => {
  const listed = client(t, { lazy: true, playwright: true, environment: { FAKE_MCP_IS_ERROR: 'browser_tabs' } });
  await listed.rpc('initialize', initialize);
  const listError = await listed.rpc('tools/call', { name: 'browser_tabs', arguments: { action: 'list' } });
  assert.deepEqual(listError.result, {
    content: [{ type: 'text', text: 'backend tool failed' }],
    structuredContent: { failure: true },
    isError: true,
  });

  const transport = client(t, { lazy: true, playwright: true, environment: { FAKE_MCP_JSON_ERROR: 'browser_tabs' } });
  await transport.rpc('initialize', initialize);
  const rejected = await transport.rpc('tools/call', {
    name: 'browser_tabs',
    arguments: { action: 'new', url: 'http://127.0.0.1:5173/start' },
  });
  assert.deepEqual(rejected.error, { code: -32602, message: 'backend rejected arguments' });
  assert.equal(rejected.result, undefined);
});

test('browser_tabs schema documents default list, new with url and the navigation fallback', async t => {
  const c = client(t, { lazy: true, playwright: true });
  await c.rpc('initialize', initialize);
  const schema = (await c.rpc('tools/list')).result.tools.find(tool => tool.name === 'browser_tabs').inputSchema;
  assert.match(schema.properties.action.description, /Defaults to list/i);
  assert.match(schema.properties.action.description, /new/);
  assert.match(schema.properties.url.description, /browser_navigate/);
  assert.match(schema.properties.url.description, /snapshot/i);
  assert.equal(schema.anyOf, undefined);
  assert.equal(schema.oneOf, undefined);
  assert.equal(fs.existsSync(c.starts), false);
});

test('the pinned Playwright catalog matches the registered backend command', () => {
  const servers = JSON.parse(fs.readFileSync(path.resolve(here, '../../mcp/servers.json'), 'utf8'));
  const catalog = JSON.parse(fs.readFileSync(path.resolve(here, '../../mcp/playwright-tools.json'), 'utf8'));
  const args = servers.playwright.args;
  const split = args.indexOf('--');
  assert.ok(split > 0, 'registry args must separate proxy options with --');
  assert.deepEqual([catalog.command, ...catalog.args], args.slice(split + 1));
  assert.ok(catalog.args.includes('--timeout-action'), 'backend keeps an explicit action timeout');
});

test('Playwright browser calls fail fast without the extension token instead of waiting', async t => {
  const c = client(t, { lazy: true, playwright: true, extension: true, token: false });
  await c.rpc('initialize', initialize);
  const response = await c.rpc('tools/call', { name: 'browser_tabs', arguments: {} });
  assert.equal(response.error.code, -32603);
  assert.match(response.error.message, /PLAYWRIGHT_MCP_EXTENSION_TOKEN/);
  const invalidUrl = await c.rpc('tools/call', { name: 'browser_tabs', arguments: { url: 'http://127.0.0.1:5173/' } });
  assert.equal(invalidUrl.error.code, -32603);
  assert.match(invalidUrl.error.message, /PLAYWRIGHT_MCP_EXTENSION_TOKEN/);
  assert.equal(fs.existsSync(c.starts), false);
});

test('Playwright resolves WSL Chrome at backend launch and preserves an explicit override', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-wsl-chrome-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const chrome = path.join(dir, 'chrome.exe');
  fs.writeFileSync(chrome, '', { mode: 0o700 });

  for (const [lookupPath, explicitPath, expectedPath] of [
    [dir, '', chrome],
    [dir, '/custom/chrome', '/custom/chrome'],
    [path.join(dir, 'missing'), '', ''],
  ]) {
    const c = client(t, { lazy: true, playwright: true, extension: true, environment: {
      WSL_DISTRO_NAME: 'test', PATH: lookupPath, PLAYWRIGHT_MCP_EXECUTABLE_PATH: explicitPath,
    } });
    await c.rpc('initialize', initialize);
    assert.equal(fs.existsSync(c.starts), false);
    const response = await c.rpc('tools/call', { name: 'browser_tabs', arguments: {} });
    assert.equal(response.result.structuredContent.chromePath, expectedPath);
  }
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
    ['590–615', '590-615'],
    ['590—615', '590-615'],
    ['590 - 615', '590-615'],
    ['615,590', '590-615'],
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

test('tokensave_body rejects calls without a symbol or node_id', async (t) => {
  const c = client(t);
  await c.rpc('initialize', initialize);
  for (const input of [{}, { symbol: '   ' }, { node_id: '' }]) {
    const response = await c.rpc('tools/call', { name: 'tokensave_body', arguments: input });
    assert.equal(response.error.code, -32602);
    assert.match(response.error.message, /symbol or node_id/);
  }
  const accepted = await c.rpc('tools/call', { name: 'tokensave_body', arguments: { name: '_clash' } });
  assert.deepEqual(accepted.result.structuredContent.arguments, { symbol: '_clash' });
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
  assert.match(hung.error.message, /^MCP backend request timed out; completion unknown$/);
  assert.equal(fs.readFileSync(c.starts, 'utf8'), 'start\nstart\n');
});

test('Playwright timeout restart preserves unknown completion and adds tab recovery guidance', async t => {
  const c = client(t, {
    lazy: true,
    playwright: true,
    recordCalls: true,
    environment: { FAKE_MCP_HANG_NAMES: 'browser_evaluate,browser_navigate' },
    policy: { requestTimeoutMs: 200, shutdownGraceMs: 20 },
  });
  await c.rpc('initialize', initialize);
  const [evaluated, navigated] = await Promise.all([
    c.rpc('tools/call', { name: 'browser_evaluate', arguments: { expression: 'location.href' } }, 'evaluate'),
    c.rpc('tools/call', { name: 'browser_navigate', arguments: { url: 'http://127.0.0.1:5173/start' } }, 'navigate'),
  ]);
  for (const response of [evaluated, navigated]) {
    assert.equal(response.error.code, -32603);
    assert.match(response.error.message, /timed out; completion unknown/);
    assert.match(response.error.message, /browser_tabs.*list|action "list"/i);
    assert.match(response.error.message, /about:blank/);
    assert.match(response.error.message, /does not prove/i);
    assert.match(response.error.message, /do not select, close or reuse/i);
    assert.match(response.error.message, /known HTTP\(S\) URL/i);
    assert.match(response.error.message, /Page URL|snapshot/i);
    assert.match(response.error.message, /refs|indices/i);
    assert.doesNotMatch(response.error.message, /127\.0\.0\.1|5173|location\.href|http:/);
  }
  assert.equal(c.p.exitCode, null);
  assert.equal(fs.readFileSync(c.calls, 'utf8').trim().split('\n').length, 2);
});

test('Playwright restart serves fresh calls and does not replay timed-out browser work', async t => {
  const c = client(t, {
    lazy: true,
    playwright: true,
    recordCalls: true,
    environment: { FAKE_MCP_HANG_NAMES: 'browser_evaluate' },
    policy: { requestTimeoutMs: 200, shutdownGraceMs: 20 },
  });
  await c.rpc('initialize', initialize);
  const timedOut = await c.rpc('tools/call', { name: 'browser_evaluate', arguments: { expression: 'location.href' } }, 'reused');
  assert.equal(timedOut.error.code, -32603);
  assert.match(timedOut.error.message, /browser_tabs.*list|action "list"/i);

  const listed = await c.rpc('tools/call', { name: 'browser_tabs' }, 'reused');
  assert.equal(listed.error, undefined);
  assert.deepEqual(listed.result.structuredContent.arguments, { action: 'list' });

  const navigated = await c.rpc('tools/call', { name: 'browser_navigate', arguments: { url: 'http://127.0.0.1:5173/start' } }, 'navigate');
  assert.equal(navigated.error, undefined);
  assert.equal(fs.readFileSync(c.starts, 'utf8'), 'start\nstart\n');
  assert.deepEqual(fs.readFileSync(c.calls, 'utf8').trim().split('\n').map(line => line.split(':')[1]), [
    'browser_evaluate',
    'browser_tabs',
    'browser_navigate',
  ]);
});

test('a repeated Playwright timeout after restart keeps the recovery guidance', async t => {
  const c = client(t, {
    lazy: true,
    playwright: true,
    recordCalls: true,
    environment: { FAKE_MCP_HANG_NAMES: 'browser_evaluate' },
    policy: { requestTimeoutMs: 200, shutdownGraceMs: 20 },
  });
  await c.rpc('initialize', initialize);
  for (const round of ['first', 'second']) {
    const timedOut = await c.rpc('tools/call', { name: 'browser_evaluate', arguments: { expression: 'location.href' } }, round);
    assert.equal(timedOut.error.code, -32603);
    assert.match(timedOut.error.message, /timed out; completion unknown/);
    assert.match(timedOut.error.message, /Playwright backend was restarted/);
    assert.match(timedOut.error.message, /browser_tabs.*list|action "list"/i);
    assert.doesNotMatch(timedOut.error.message, /location\.href|http:/);
  }
  assert.equal(c.p.exitCode, null);
  const listed = await c.rpc('tools/call', { name: 'browser_tabs' });
  assert.equal(listed.error, undefined);
  assert.deepEqual(listed.result.structuredContent.arguments, { action: 'list' });
  assert.deepEqual(fs.readFileSync(c.calls, 'utf8').trim().split('\n').map(line => line.split(':')[1]), [
    'browser_evaluate',
    'browser_evaluate',
    'browser_tabs',
  ]);
});

test('a cancelled Playwright browser call gets no recovery text and is not replayed', async t => {
  const c = client(t, {
    lazy: true,
    playwright: true,
    recordCalls: true,
    environment: { FAKE_MCP_HANG_NAMES: 'browser_evaluate' },
    policy: { requestTimeoutMs: 150, shutdownGraceMs: 20 },
  });
  await c.rpc('initialize', initialize);
  const listed = await c.rpc('tools/call', { name: 'browser_tabs' });
  assert.equal(listed.error, undefined);
  c.send({ id: 'cancelled-eval', method: 'tools/call', params: { name: 'browser_evaluate', arguments: { expression: 'location.href' } } });
  await new Promise((resolve) => setTimeout(resolve, 40));
  c.send({ method: 'notifications/cancelled', params: { requestId: 'cancelled-eval' } });
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(c.messages.filter((message) => message.id === 'cancelled-eval').length, 0);
  assert.equal(c.p.exitCode, null);
  const after = await c.rpc('tools/call', { name: 'browser_tabs' });
  assert.equal(after.error, undefined);
  assert.equal(fs.readFileSync(c.starts, 'utf8'), 'start\n');
  assert.deepEqual(fs.readFileSync(c.calls, 'utf8').trim().split('\n').map(line => line.split(':')[1]), [
    'browser_tabs',
    'browser_evaluate',
    'browser_tabs',
  ]);
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

test('a lazy handshake longer than the request deadline still gives the request its full deadline', async t => {
  const c = client(t, { lazy: true, handshakeDelayMs: 300, policy: { requestTimeoutMs: 150, shutdownGraceMs: 20 } });
  await c.rpc('initialize', initialize);
  const call = await c.rpc('tools/call', { name: 'read' });
  assert.equal(call.error, undefined);
  assert.equal(call.result.content[0].text, 'file content once');
  assert.equal(fs.readFileSync(c.starts, 'utf8'), 'start\n');
});

test('cancelling during a delayed handshake neither sends the call nor breaks the next one', async t => {
  const c = client(t, { lazy: true, handshakeDelayMs: 300, recordCalls: true, policy: { requestTimeoutMs: 1000, shutdownGraceMs: 20 } });
  await c.rpc('initialize', initialize);
  c.send({ id: 'waiting', method: 'tools/call', params: { name: 'read' } });
  const deadline = Date.now() + 1000;
  while (!fs.existsSync(c.starts) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(fs.existsSync(c.starts));
  c.send({ method: 'notifications/cancelled', params: { requestId: 'waiting' } });

  const next = await c.rpc('tools/call', { name: 'read' }, 'next');
  assert.equal(next.error, undefined);
  assert.equal(next.result.content[0].text, 'file content once');
  assert.equal(c.messages.filter((message) => message.id === 'waiting').length, 0);
  assert.equal(fs.readFileSync(c.calls, 'utf8'), 'next:read\n');
  assert.equal(c.p.exitCode, null);
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
