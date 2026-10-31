#!/usr/bin/env node
// Refresh/verify the catalog of a pinned lazy MCP backend; no browser is opened.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import assert from 'node:assert/strict';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const [name, flag] = process.argv.slice(2);
const servers = JSON.parse(fs.readFileSync(path.join(root, 'mcp/servers.json'), 'utf8'));
const args = servers[name]?.args;
if (!args || !args.includes('--catalog') || (flag && flag !== '--check')) {
  throw new Error('usage: node bin/mcp-catalog.mjs <lazy-server> [--check]');
}
const expand = (s) => s.startsWith('~/') ? path.join(os.homedir(), s.slice(2)) : s;
const catalogArg = args[args.indexOf('--catalog') + 1];
// Write to this checkout, not to a potentially different installed harness.
const file = path.join(root, 'mcp', path.basename(catalogArg));
const split = args.indexOf('--');
const command = args[split + 1];
const backendArgs = args.slice(split + 2).map(expand);
const child = spawn(command, backendArgs, { stdio: ['pipe', 'pipe', 'inherit'] });
const pending = new Map();
let nextId = 0;
const timer = setTimeout(() => { child.kill(); throw new Error('MCP catalog request timed out'); }, 30000);
const input = createInterface({ input: child.stdout });
input.on('line', (line) => {
  const message = JSON.parse(line);
  const request = pending.get(message.id);
  if (!request) return;
  pending.delete(message.id);
  if (message.error) request.reject(new Error(message.error.message));
  else request.resolve(message.result);
});
child.on('error', (error) => { for (const request of pending.values()) request.reject(error); });
child.on('exit', () => { for (const request of pending.values()) request.reject(new Error('MCP backend exited')); });
function call(method, params) {
  return new Promise((resolve, reject) => {
    const id = ++nextId;
    pending.set(id, { resolve, reject });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });
}
try {
  const initialize = await call('initialize', {
    protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'harness-catalog', version: '1' },
  });
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
  const tools = [];
  let cursor;
  do {
    const page = await call('tools/list', cursor ? { cursor } : {});
    tools.push(...page.tools);
    cursor = page.nextCursor;
  } while (cursor);
  const catalog = { command, args: backendArgs, initialize, tools };
  if (flag === '--check') assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), catalog);
  else fs.writeFileSync(file, `${JSON.stringify(catalog, null, 2)}\n`);
  console.log(`${name}: ${tools.length} tools; catalog ${flag === '--check' ? 'verified' : 'written'}`);
} finally {
  clearTimeout(timer);
  child.stdin.end();
  const stop = setTimeout(() => child.kill(), 1000);
  stop.unref();
}
