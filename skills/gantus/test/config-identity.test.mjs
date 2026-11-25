import assert from 'node:assert/strict';
import { test } from 'node:test';
import { apiFixture, createArgs, gantusEnv, runCli, sendJson, startServer } from './helpers.mjs';

const get = ['get', '--key', 'STR-12'];

test('invalid or missing config stops before sending credentials', async (t) => {
  const server = await startServer((req, res) => sendJson(res, 200, {}));
  t.after(() => server.close());

  const cases = [
    [{}, /GANTUS_BASE_URL/],
    [gantusEnv('http://192.0.2.10:8080'), /loopback/],
    [gantusEnv(server.url.replace('http://', 'http://user:pass@')), /учётные данные/],
    [gantusEnv(`${server.url}/api`), /без пути/],
    [gantusEnv(server.url, { GANTUS_TEAM_ID: '' }), /GANTUS_TEAM_ID/],
    [gantusEnv(server.url, { GANTUS_SESSION_COOKIE: 'session=x\r\nX-Injected: 1' }), /GANTUS_SESSION_COOKIE/]
  ];
  for (const [env, expected] of cases) {
    const result = await runCli(get, { env });
    assert.equal(result.status, 2);
    assert.match(result.stderr, expected);
    assert.doesNotMatch(result.stderr, /test-cookie|user:pass/);
  }
  assert.equal(server.requests.length, 0);
});

test('redirect is not followed or allowed to forward the session', async (t) => {
  const other = await startServer((req, res) => sendJson(res, 200, {}));
  const server = await startServer((req, res) => {
    res.writeHead(302, { Location: `${other.url}/elsewhere` });
    res.end();
  });
  t.after(() => Promise.all([server.close(), other.close()]));

  const result = await runCli(get, { env: gantusEnv(server.url) });

  assert.match(result.stderr, /HTTP 302/);
  assert.equal(server.requests.length, 1);
  assert.equal(other.requests.length, 0);
});

test('the configured loopback origin receives the request, not an inherited proxy', async (t) => {
  const api = await apiFixture(t);
  const proxy = await startServer((req, res) => sendJson(res, 403, {}));
  t.after(() => proxy.close());

  const result = await api.run(get, { env: { http_proxy: proxy.url, NO_PROXY: '', no_proxy: '' } });

  assert.equal(proxy.requests.length, 0);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(api.server.requests[0].headers.cookie, 'session=test-cookie');
});

test('expired session and wrong identity stop before board access', async (t) => {
  for (const [status, body, message] of [
    [401, { secret: 'hidden-body' }, /401.*GANTUS_SESSION_COOKIE/],
    [200, { id: 8 }, /GANTUS_USER_ID/]
  ]) {
    const server = await startServer((req, res) => sendJson(res, status, body));
    t.after(() => server.close());

    const result = await runCli(get, { env: gantusEnv(server.url) });

    assert.equal(result.status, 1);
    assert.match(result.stderr, message);
    assert.doesNotMatch(result.stderr, /test-cookie|hidden-body/);
    assert.deepEqual(server.requests.map((req) => req.url), ['/api/auth/me']);
  }
});

test('server 403 on create does not leak the response or repeat the POST', async (t) => {
  const api = await apiFixture(t, { write: () => [403, { error: 'hidden-body' }] });

  const result = await api.run(createArgs);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /HTTP 403/);
  assert.doesNotMatch(result.stderr, /hidden-body|test-cookie/);
  assert.equal(api.writes().length, 1);
});
