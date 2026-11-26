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
printf '%s\\n' "$@" > "$FAKE_GL_ARGS"
case " $* " in
  *" --include "*) if [ "\${FAKE_GL_INCLUDE:-1}" = "1" ]; then
    case "\${FAKE_GL_INCLUDE_HEADERS:-1}" in
      0) printf 'HTTP/1.1 %s Fake\\n\\r\\n' "$FAKE_GL_STATUS" ;;
      missing) printf 'HTTP/1.1 %s Fake\\n' "$FAKE_GL_STATUS" ;;
      *) printf 'HTTP/1.1 %s Fake\\r\\nContent-Type: application/json\\r\\n\\r\\n' "$FAKE_GL_STATUS" ;;
    esac
  fi ;;
esac
printf '%s' "$FAKE_GL_BODY"
printf '%s' "$FAKE_GL_ERROR" >&2
exit "$FAKE_GL_EXIT"
`, { mode: 0o755 });
fs.writeFileSync(path.join(fakeBin, 'curl'), `#!/bin/sh
printf '%s\\n' "$@" > "$FAKE_CURL_ARGS"
printf 'call\\n' >> "$FAKE_CURL_CALLS"
cat > "$FAKE_CURL_HEADERS"
printf '%s' "$FAKE_CURL_BODY"
exit "$FAKE_CURL_EXIT"
`, { mode: 0o755 });
const env = { ...process.env, PATH: `${fakeBin}:${process.env.PATH}`,
  FAKE_GL_BODY: '{"iid":42}', FAKE_GL_ERROR: '', FAKE_GL_EXIT: '0',
  FAKE_GL_STATUS: '200', FAKE_GL_INCLUDE: '1',
  FAKE_GL_ARGS: path.join(tmp, 'glab-args'),
  FAKE_CURL_BODY: '{"iid":43}\n201', FAKE_CURL_EXIT: '0', FAKE_CURL_ARGS: path.join(tmp, 'args'),
  FAKE_CURL_CALLS: path.join(tmp, 'curl-calls'),
  FAKE_CURL_HEADERS: path.join(tmp, 'headers') };
for (const key of ['GITLAB_TOKEN', 'GLAB_TOKEN', 'GITLAB_ACCESS_TOKEN']) delete env[key];
const run = (overrides = {}, args = []) => spawnSync(process.execPath,
  [path.join(root, 'bin/gitlab-api.mjs'), '--hostname', 'gitlab.example.test',
    ...args, 'projects/example%2Frepo/merge_requests'],
  { env: { ...env, ...overrides }, encoding: 'utf8', timeout: 5000 });
const curlCalls = () => fs.existsSync(env.FAKE_CURL_CALLS)
  ? fs.readFileSync(env.FAKE_CURL_CALLS, 'utf8').split('\n').filter(Boolean).length : 0;
const resetCurl = () => fs.rmSync(env.FAKE_CURL_CALLS, { force: true });

try {
  let result = run();
  assert.equal(result.status, 0, JSON.stringify({ error: result.error?.message, stderr: result.stderr, stdout: result.stdout }));
  assert.equal(JSON.parse(result.stdout).iid, 42, 'existing glab session needs no token');
  assert.equal(fs.existsSync(env.FAKE_CURL_ARGS), false);
  assert.equal(curlCalls(), 0, 'glab session never starts curl');
  assert.ok(!fs.readFileSync(env.FAKE_GL_ARGS, 'utf8').includes('Content-Type:'));

  const input = path.join(tmp, 'mr.json');
  fs.writeFileSync(input, JSON.stringify({ title: 'Test merge request' }));
  for (const method of ['POST', 'PUT', 'PATCH']) {
    result = run({}, ['--method', method, '--input', input]);
    assert.equal(result.status, 0, result.stderr);
    const glabArgs = fs.readFileSync(env.FAKE_GL_ARGS, 'utf8').trimEnd().split('\n');
    assert.deepEqual(glabArgs, ['api', '--hostname', 'gitlab.example.test', '--method', method,
      '--input', input, '--header', 'Content-Type: application/json',
      'projects/example%2Frepo/merge_requests']);
    assert.equal(fs.existsSync(env.FAKE_CURL_ARGS), false);
  }

  fs.unlinkSync(env.FAKE_GL_ARGS);
  for (const args of [[], ['--method', 'PUT', '--single-attempt', '--input', input]]) {
    resetCurl();
    result = run({ GITLAB_TOKEN: 'synthetic-audit-token' }, args);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).iid, 43, 'a configured token selects curl directly');
    assert.equal(fs.existsSync(env.FAKE_GL_ARGS), false, 'a configured token never launches glab');
    assert.equal(curlCalls(), 1, 'a configured token makes exactly one curl call');
    const curlArgs = fs.readFileSync(env.FAKE_CURL_ARGS, 'utf8');
    assert.ok(!curlArgs.includes('synthetic-audit-token'), 'token never enters argv');
    assert.ok(!result.stdout.includes('synthetic-audit-token'));
    assert.match(curlArgs, /^--globoff$/m);
    assert.ok(!/^-L$|^--location$/m.test(curlArgs), 'redirects are not followed');
    if (args.length) assert.ok(curlArgs.includes('Content-Type: application/json'));
  }

  for (const name of ['GLAB_TOKEN', 'GITLAB_ACCESS_TOKEN']) {
    resetCurl();
    result = run({ [name]: 'synthetic-audit-token' });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).iid, 43, `${name} selects curl directly`);
    assert.equal(fs.existsSync(env.FAKE_GL_ARGS), false, `${name} never launches glab`);
    assert.equal(curlCalls(), 1, `${name} makes exactly one curl call`);
    assert.equal(fs.readFileSync(env.FAKE_CURL_HEADERS, 'utf8'), 'PRIVATE-TOKEN: synthetic-audit-token\n');
  }

  const configFailure = { FAKE_GL_EXIT: '1', FAKE_GL_ERROR: 'failed to read configuration: read-only file system', FAKE_GL_BODY: '' };
  resetCurl();
  result = run({ ...configFailure, GITLAB_TOKEN: 'synthetic-audit-token' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).iid, 43);
  assert.equal(curlCalls(), 1, 'a token GET makes exactly one curl call');
  const argv = fs.readFileSync(env.FAKE_CURL_ARGS, 'utf8');
  assert.ok(argv.includes('--max-time\n60'));
  assert.ok(!argv.includes('synthetic-audit-token'), 'token never enters argv');
  assert.equal(fs.readFileSync(env.FAKE_CURL_HEADERS, 'utf8'), 'PRIVATE-TOKEN: synthetic-audit-token\n');
  assert.equal(fs.existsSync(env.FAKE_GL_ARGS), false, 'token request never launches glab');

  resetCurl();
  result = run({ ...configFailure, GITLAB_TOKEN: 'synthetic-audit-token', FAKE_CURL_BODY: '{"message":"Unauthorized"}\n401' });
  assert.notEqual(result.status, 0, 'HTTP failure must not become success');
  assert.match(result.stderr, /HTTP 401/);
  assert.doesNotMatch(result.stderr, /результат записи неизвестен/);
  assert.ok(!result.stderr.includes('synthetic-audit-token'));
  assert.equal(curlCalls(), 1, 'a definite rejection is not retried');
  assert.equal(fs.existsSync(env.FAKE_GL_ARGS), false, 'token HTTP failure never falls back to glab');

  resetCurl();
  result = run(configFailure);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /не признак истёкшей сессии/);
  assert.equal(curlCalls(), 0, 'glab failure never starts curl');

  fs.unlinkSync(env.FAKE_GL_ARGS);
  resetCurl();
  result = run({ FAKE_CURL_BODY: '{"message":"Bad Gateway"}\n502', GITLAB_TOKEN: 'synthetic-audit-token' }, ['--method', 'POST']);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /HTTP 502/);
  assert.match(result.stderr, /результат записи неизвестен, повтор запрещён/);
  assert.equal(curlCalls(), 1, 'a mutating 502 is never retried');
  assert.equal(fs.existsSync(env.FAKE_GL_ARGS), false, 'token HTTP failure never falls back to glab');

  resetCurl();
  result = run({ FAKE_CURL_BODY: '{"message":"Bad Gateway"}\n502', GITLAB_TOKEN: 'synthetic-audit-token' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /HTTP 502: GET не выполнен/);
  assert.doesNotMatch(result.stderr, /результат записи неизвестен/, 'a GET failure is diagnosed as a read');
  assert.equal(curlCalls(), 1, 'a failed GET is not retried');

  resetCurl();
  result = run({ FAKE_CURL_EXIT: '28', FAKE_CURL_BODY: '', GITLAB_TOKEN: 'synthetic-audit-token' }, ['--method', 'PUT', '--input', input]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /результат записи неизвестен, повтор запрещён/);
  assert.equal(curlCalls(), 1, 'a transport failure is never retried');
  assert.equal(fs.existsSync(env.FAKE_GL_ARGS), false, 'transport failure never launches glab or repeats');

  resetCurl();
  result = run({ FAKE_CURL_BODY: '{"redirect":true}\n302', GITLAB_TOKEN: 'synthetic-audit-token' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /HTTP 302: GET не выполнен/);
  assert.doesNotMatch(result.stderr, /результат записи неизвестен/);
  assert.equal(curlCalls(), 1, 'a redirect is not followed');
  assert.equal(fs.existsSync(env.FAKE_GL_ARGS), false, 'redirects are not followed through glab');

  resetCurl();
  result = run({ FAKE_CURL_BODY: '{"redirect":true}\n302', GITLAB_TOKEN: 'synthetic-audit-token' }, ['--method', 'PUT', '--input', input]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /HTTP 302: результат записи неизвестен, повтор запрещён/);
  assert.equal(curlCalls(), 1, 'a mutating redirect status is never retried');

  resetCurl();
  result = run({ FAKE_CURL_BODY: '{"message":"Conflict"}\n409', GITLAB_TOKEN: 'synthetic-audit-token' }, ['--method', 'PUT', '--input', input]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /HTTP 409/);
  assert.doesNotMatch(result.stderr, /результат записи неизвестен/, 'a definite 409 stays a rejection');
  assert.equal(curlCalls(), 1, 'a definite 409 is not retried');

  resetCurl();
  result = run({ FAKE_CURL_BODY: '{"message":"Unauthorized"}\n401', GITLAB_TOKEN: 'synthetic-audit-token' }, ['--method', 'PUT', '--input', input]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /HTTP 401/);
  assert.doesNotMatch(result.stderr, /результат записи неизвестен/, 'a definite 401 stays a rejection');
  assert.equal(curlCalls(), 1, 'a definite 401 is not retried');

  if (fs.existsSync(env.FAKE_CURL_ARGS)) fs.unlinkSync(env.FAKE_CURL_ARGS);
  resetCurl();
  result = run({
    FAKE_GL_BODY: '{"iid":44}',
    FAKE_GL_STATUS: '200'
  }, ['--method', 'PUT', '--single-attempt', '--input', input]);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { iid: 44 }, 'strict glab returns the JSON body without headers');
  assert.doesNotMatch(result.stdout, /HTTP\/1\.1|Content-Type/);
  assert.doesNotMatch(result.stderr, /HTTP\/1\.1|Content-Type/);
  assert.match(fs.readFileSync(env.FAKE_GL_ARGS, 'utf8'), /^--include$/m, 'strict glab asks for the real HTTP status line');
  assert.equal(fs.existsSync(env.FAKE_CURL_ARGS), false);
  assert.equal(curlCalls(), 0, 'strict glab success never starts curl');

  for (const [status, body, expected] of [
    ['200', '{"iid":45}', { iid: 45 }],
    ['204', '', null]
  ]) {
    result = run({
      FAKE_GL_INCLUDE_HEADERS: '0',
      FAKE_GL_STATUS: status,
      FAKE_GL_BODY: body
    }, ['--method', 'PUT', '--single-attempt', '--input', input]);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), expected, `no-header ${status} preserves the body`);
    assert.doesNotMatch(result.stdout, /HTTP\/1\.1|Content-Type/);
  }

  result = run({
    FAKE_GL_INCLUDE_HEADERS: 'missing',
    FAKE_GL_STATUS: '200',
    FAKE_GL_BODY: '{"iid":46}'
  }, ['--method', 'PUT', '--single-attempt', '--input', input]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /некорректный HTTP-ответ/);
  assert.doesNotMatch(result.stdout, /iid|HTTP\/1\.1|Content-Type/);

  result = run({
    FAKE_GL_INCLUDE_HEADERS: 'missing',
    FAKE_GL_STATUS: '200',
    FAKE_GL_BODY: '',
    FAKE_GL_EXIT: '0'
  }, ['--method', 'PUT', '--single-attempt', '--input', input]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /некорректный HTTP-ответ; результат записи неизвестен, повтор запрещён/);
  assert.doesNotMatch(result.stdout, /HTTP\/1\.1|Content-Type/);

  result = run({
    FAKE_GL_STATUS: '200',
    FAKE_GL_BODY: '{"iid":47}',
    FAKE_GL_EXIT: '1'
  }, ['--method', 'PUT', '--single-attempt', '--input', input]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /результат записи неизвестен, повтор запрещён/);
  assert.equal(result.stdout, '');
  assert.doesNotMatch(result.stdout, /iid|HTTP\/1\.1|Content-Type/);

  result = run({
    FAKE_GL_INCLUDE_HEADERS: 'missing',
    FAKE_GL_STATUS: '409',
    FAKE_GL_BODY: '',
    FAKE_GL_EXIT: '1'
  }, ['--method', 'PUT', '--single-attempt', '--input', input]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /HTTP 409: запрос отклонён сервером/);
  assert.doesNotMatch(result.stderr, /результат записи неизвестен/);

  result = run({
    FAKE_GL_INCLUDE_HEADERS: '0',
    FAKE_GL_STATUS: '409',
    FAKE_GL_BODY: '{"message":"Conflict"}',
    FAKE_GL_EXIT: '1'
  }, ['--method', 'PUT', '--single-attempt', '--input', input]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /HTTP 409/);
  assert.doesNotMatch(result.stderr, /результат записи неизвестен/);

  result = run({
    FAKE_GL_EXIT: '1',
    FAKE_GL_STATUS: '502',
    FAKE_GL_BODY: '{"message":"upstream HTTP 409"}',
    FAKE_GL_ERROR: 'glab: upstream HTTP 409 (HTTP 502)'
  }, ['--method', 'PUT', '--single-attempt', '--input', input]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /HTTP 502: результат записи неизвестен, повтор запрещён/);
  assert.doesNotMatch(result.stderr, /HTTP 409/, 'a 409 in the server text never becomes the real status');
  assert.equal(fs.existsSync(env.FAKE_CURL_ARGS), false);

  result = run({
    FAKE_GL_EXIT: '1',
    FAKE_GL_STATUS: '403',
    FAKE_GL_BODY: '{"message":"permission denied"}',
    FAKE_GL_ERROR: 'glab: permission denied (HTTP 403)'
  }, ['--method', 'PUT', '--single-attempt', '--input', input]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /HTTP 403/);
  assert.equal(fs.existsSync(env.FAKE_CURL_ARGS), false, 'strict mode never replays after glab ran');

  result = run({
    FAKE_GL_EXIT: '1',
    FAKE_GL_STATUS: '502',
    FAKE_GL_BODY: '{"message":"Bad Gateway"}',
    FAKE_GL_ERROR: 'glab: Bad Gateway (HTTP 502)'
  }, ['--method', 'PUT', '--single-attempt', '--input', input]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /HTTP 502: результат записи неизвестен, повтор запрещён/);
  assert.equal(fs.existsSync(env.FAKE_CURL_ARGS), false);

  result = run({
    FAKE_GL_EXIT: '1',
    FAKE_GL_STATUS: '409',
    FAKE_GL_BODY: '{"message":"Conflict"}',
    FAKE_GL_ERROR: 'glab: Conflict (HTTP 409)'
  }, ['--method', 'PUT', '--single-attempt', '--input', input]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /HTTP 409/);
  assert.doesNotMatch(result.stderr, /результат записи неизвестен/, 'a real 409 stays definite');
  assert.equal(fs.existsSync(env.FAKE_CURL_ARGS), false);

  result = run({
    FAKE_GL_EXIT: '1',
    FAKE_GL_INCLUDE: '0',
    FAKE_GL_BODY: '{"message":"missing status"}'
  }, ['--method', 'PUT', '--single-attempt', '--input', input]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /не вернул HTTP-статус; результат записи неизвестен, повтор запрещён/);
  assert.equal(fs.existsSync(env.FAKE_CURL_ARGS), false);

  const curlOnly = path.join(tmp, 'curl-only');
  const shellTools = path.join(tmp, 'shell-tools');
  fs.mkdirSync(curlOnly);
  fs.mkdirSync(shellTools);
  fs.symlinkSync('/usr/bin/cat', path.join(shellTools, 'cat'));
  fs.copyFileSync(path.join(fakeBin, 'curl'), path.join(curlOnly, 'curl'));
  fs.chmodSync(path.join(curlOnly, 'curl'), 0o755);
  resetCurl();
  result = run({
    PATH: `${shellTools}:${curlOnly}`,
    GITLAB_TOKEN: 'synthetic-audit-token',
    FAKE_CURL_BODY: '{"iid":43}\n200'
  }, ['--method', 'PUT', '--single-attempt', '--input', input]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(curlCalls(), 1, 'a strict write makes exactly one curl call');
  const strictArgv = fs.readFileSync(env.FAKE_CURL_ARGS, 'utf8').trimEnd().split('\n');
  assert.equal(strictArgv[0], '-q', 'strict curl ignores user rc');
  assert.ok(strictArgv.includes('--globoff'), 'strict curl ignores URL globbing');
  assert.ok(!strictArgv.includes('-L') && !strictArgv.includes('--location'), 'strict curl does not follow redirects');
  assert.ok(strictArgv.includes('Content-Type: application/json'));
  assert.equal(fs.readFileSync(env.FAKE_CURL_HEADERS, 'utf8'), 'PRIVATE-TOKEN: synthetic-audit-token\n');

  resetCurl();
  result = run({ PATH: `${shellTools}:${curlOnly}` });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /glab недоступен; токен окружения отсутствует/);
  assert.equal(curlCalls(), 0, 'a missing glab and token never falls through to curl');

  result = run({ GITLAB_TOKEN: 'invalid\r\nheader' });
  assert.notEqual(result.status, 0);
  result = run({ FAKE_GL_BODY: 'not-json' });
  assert.notEqual(result.status, 0);
  console.log('GitLab API: glab session, token via curl, HTTP errors and no duplicate writes passed');
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
