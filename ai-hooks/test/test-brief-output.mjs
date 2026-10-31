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
for (const status of [0, 7]) {
  const result = spawnSync('bash', [script, process.execPath, '-e',
    'for(let i=0;i<1000;i++) process.stdout.write(`progress-${i}\\r`); process.exit(Number(process.argv[1]));',
    String(status)], { encoding: 'utf8' });
  assert.equal(result.status, status, result.stderr);
  const log = result.stdout.match(/full_log=(.+)/)?.[1];
  assert.ok(log);
  const full = fs.readFileSync(log, 'utf8');
  assert.equal(full, Array.from({ length: 1000 }, (_, i) => `progress-${i}\r`).join(''));
  assert.ok(result.stdout.length < 5000, 'carriage-return progress must be bounded');
  assert.ok(!result.stdout.includes('progress-500'));
  assert.ok(result.stdout.includes('progress-999'));
}
for (const status of [0, 7]) {
  const result = spawnSync("bash", [script, process.execPath, "-e",
    "process.stdout.write(String.fromCharCode(120).repeat(200000)); process.exit(Number(process.argv[1]));",
    String(status)], { encoding: "utf8" });
  assert.equal(result.status, status, result.stderr);
  const log = result.stdout.match(/full_log=(.+)/)?.[1];
  assert.ok(log);
  assert.equal(fs.statSync(log).size, 200000);
  assert.ok(result.stdout.includes("вывод ограничен по размеру"));
  assert.ok(Buffer.byteLength(result.stdout, "utf8") <= 13000, "single-line output must be byte-bounded");
}
console.log('brief-output: exit status, full log, excerpts and literal argv passed');
for (const status of [0, 7]) {
  const result = spawnSync('bash', [script, process.execPath, '-e',
    'process.stdout.write("😀я".repeat(40000)); process.exit(Number(process.argv[1]));', String(status)], { encoding: 'utf8' });
  assert.equal(result.status, status, result.stderr);
  assert.equal(result.stdout.includes('�'), false, 'byte limit must preserve valid UTF-8');
  assert.ok(Buffer.byteLength(result.stdout) <= 13000);
}
