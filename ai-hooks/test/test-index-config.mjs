import './env-isolate.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'index-config-test-'));
fs.mkdirSync(path.join(tmp, 'bin'));
fs.mkdirSync(path.join(tmp, '.tokensave'));
const script = path.join(tmp, 'bin/harness-index-config.mjs');
fs.copyFileSync(path.join(root, 'bin/harness-index-config.mjs'), script);
const file = path.join(tmp, '.tokensave/config.json');
const original = JSON.stringify({ exclude: ['bin/**', 'private/**'], auto_track: false, custom: 'keep' });
fs.writeFileSync(file, original);
const run = (...args) => spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', timeout: 5000 });
try {
  assert.equal(run('--check').status, 1);
  assert.equal(fs.readFileSync(file, 'utf8'), original, '--check is read-only');
  assert.equal(run().status, 0);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { exclude: ['private/**'], auto_track: false, custom: 'keep' });
  assert.equal(run('--check').status, 0);
  const once = fs.readFileSync(file, 'utf8');
  assert.equal(run().status, 0);
  assert.equal(fs.readFileSync(file, 'utf8'), once, 'idempotent');
  console.log('Index config: coverage restored, custom settings preserved, check is read-only');
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
