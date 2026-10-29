import './env-isolate.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../bin/brief-output.sh', import.meta.url));
for (const status of [0, 7]) {
  const result = spawnSync('bash', [script, process.execPath, '-e',
    'for(let i=0;i<200;i++) console.log(`row-${i}`); console.error(process.argv[1]); process.exit(Number(process.argv[2]));',
    'literal $(echo unsafe); space', String(status)], { encoding: 'utf8' });
  assert.equal(result.status, status, result.stderr);
  const log = result.stdout.match(/full_log=(.+)/)?.[1];
  assert.ok(log);
  const full = fs.readFileSync(log, 'utf8');
  assert.ok(full.includes('row-100\n'));
  assert.ok(full.includes('literal $(echo unsafe); space'));
  assert.ok(!result.stdout.includes('row-100\n'));
  assert.ok(result.stdout.includes('row-199\n'));
  assert.equal(result.stdout.includes('row-0\n'), status !== 0);
}
assert.equal(spawnSync('bash', [script]).status, 2);
console.log('brief-output: exit status, full log, excerpts and literal argv passed');
