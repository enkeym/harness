import './env-isolate.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gitlab-api-test-'));
const fakeBin = path.join(tmp, 'bin');
fs.mkdirSync(fakeBin);
fs.writeFileSync(path.join(fakeBin, 'glab'), `#!/bin/sh
printf '%s' "$FAKE_GL_BODY"
printf '%s' "$FAKE_GL_ERROR" >&2
exit "$FAKE_GL_EXIT"
`, { mode: 0o755 });
fs.writeFileSync(path.join(fakeBin, 'curl'), `#!/bin/sh
printf '%s\\n' "$@" > "$FAKE_CURL_ARGS"
cat > "$FAKE_CURL_HEADERS"
printf '%s' "$FAKE_CURL_BODY"
exit 0
`, { mode: 0o755 });
const env = { ...process.env, PATH: `${fakeBin}:${process.env.PATH}`,
  FAKE_GL_BODY: '{"iid":42}', FAKE_GL_ERROR: '', FAKE_GL_EXIT: '0',
  FAKE_CURL_BODY: '{"iid":43}\n201', FAKE_CURL_ARGS: path.join(tmp, 'args'),
  FAKE_CURL_HEADERS: path.join(tmp, 'headers') };
for (const key of ['GITLAB_TOKEN', 'GLAB_TOKEN', 'GITLAB_ACCESS_TOKEN']) delete env[key];
const run = (overrides = {}, args = []) => spawnSync(process.execPath,
  [path.join(root, 'bin/gitlab-api.mjs'), '--hostname', 'gitlab.example.test',
    ...args, 'projects/example%2Frepo/merge_requests'],
  { env: { ...env, ...overrides }, encoding: 'utf8', timeout: 5000 });

try {
  let result = run();
  assert.equal(result.status, 0, JSON.stringify({ error: result.error?.message, stderr: result.stderr, stdout: result.stdout }));
  assert.equal(JSON.parse(result.stdout).iid, 42, 'existing glab session needs no token');
  assert.equal(fs.existsSync(env.FAKE_CURL_ARGS), false);

  const configFailure = { FAKE_GL_EXIT: '1', FAKE_GL_ERROR: 'failed to read configuration: read-only file system', FAKE_GL_BODY: '' };
  result = run({ ...configFailure, GITLAB_TOKEN: 'synthetic-audit-token' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).iid, 43);
  const argv = fs.readFileSync(env.FAKE_CURL_ARGS, 'utf8');
  assert.ok(argv.includes('--max-time\n60'));
  assert.ok(!argv.includes('synthetic-audit-token'), 'token never enters argv');
  assert.equal(fs.readFileSync(env.FAKE_CURL_HEADERS, 'utf8'), 'PRIVATE-TOKEN: synthetic-audit-token\n');

  result = run({ ...configFailure, GITLAB_TOKEN: 'synthetic-audit-token', FAKE_CURL_BODY: '{"message":"Unauthorized"}\n401' });
  assert.notEqual(result.status, 0, 'HTTP failure must not become success');
  assert.match(result.stderr, /HTTP 401/);
  assert.ok(!result.stderr.includes('synthetic-audit-token'));

  result = run(configFailure);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /не признак истёкшей сессии/);

  fs.unlinkSync(env.FAKE_CURL_ARGS);
  result = run({ FAKE_GL_EXIT: '1', FAKE_GL_ERROR: 'HTTP 502 Bad Gateway', GITLAB_TOKEN: 'synthetic-audit-token' }, ['--method', 'POST']);
  assert.notEqual(result.status, 0);
  assert.equal(fs.existsSync(env.FAKE_CURL_ARGS), false, 'ambiguous write is never retried through curl');

  result = run({ GITLAB_TOKEN: 'invalid\r\nheader' });
  assert.notEqual(result.status, 0);
  result = run({ FAKE_GL_BODY: 'not-json' });
  assert.notEqual(result.status, 0);
  console.log('GitLab API: glab session, safe fallback, HTTP errors and no duplicate POST passed');
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
