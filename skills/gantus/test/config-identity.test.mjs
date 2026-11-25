import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadConfig } from '../scripts/config.mjs';
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

test('testing sync configuration is either absent or complete', async (t) => {
  const server = await startServer((req, res) => sendJson(res, 200, {}));
  t.after(() => server.close());

  for (const env of [
    gantusEnv(server.url, { GANTUS_TESTING_COLUMN_ID: 'col-testing' }),
    gantusEnv(server.url, { GANTUS_TESTING_FROM_COLUMN_IDS: 'col-todo' }),
    gantusEnv(server.url, {
      GANTUS_TESTING_COLUMN_ID: 'bad id', GANTUS_TESTING_FROM_COLUMN_IDS: 'col-todo'
    })
  ]) {
    const result = await runCli(get, { env });
    assert.equal(result.status, 2);
  }
  assert.equal(server.requests.length, 0);
});

test('an exact opt-in accepts one private HTTP origin without a request', () => {
  const config = loadConfig(gantusEnv('http://10.13.35.2:3100/', {
    GANTUS_ALLOW_HTTP_ORIGIN: 'http://10.13.35.2:3100'
  }));

  assert.equal(config.origin, 'http://10.13.35.2:3100');
  assert.equal(config.protocol, 'http:');
  assert.equal(config.cookie, 'session=test-cookie');
});

test('the HTTP opt-in rejects every other origin and host before a request', async () => {
  const cases = [
    [gantusEnv('http://10.13.35.2:3100'), /GANTUS_ALLOW_HTTP_ORIGIN/],
    [gantusEnv('http://10.13.35.2:3100', {
      GANTUS_ALLOW_HTTP_ORIGIN: 'http://10.13.35.3:3100'
    }), /GANTUS_ALLOW_HTTP_ORIGIN/],
    [gantusEnv('http://10.13.35.2:3100', {
      GANTUS_ALLOW_HTTP_ORIGIN: 'http://10.13.35.2:3101'
    }), /GANTUS_ALLOW_HTTP_ORIGIN/],
    [gantusEnv('http://10.13.35.2:3100/api', {
      GANTUS_ALLOW_HTTP_ORIGIN: 'http://10.13.35.2:3100'
    }), /без пути/],
    [gantusEnv('http://user:pass@10.13.35.2:3100', {
      GANTUS_ALLOW_HTTP_ORIGIN: 'http://10.13.35.2:3100'
    }), /учётные данные/],
    [gantusEnv('http://203.0.113.10:3100', {
      GANTUS_ALLOW_HTTP_ORIGIN: 'http://203.0.113.10:3100'
    }), /RFC1918/],
    [gantusEnv('http://gantus.internal:3100', {
      GANTUS_ALLOW_HTTP_ORIGIN: 'http://gantus.internal:3100'
    }), /RFC1918/]
  ];
  for (const [env, expected] of cases) {
    const result = await runCli(get, { env });
    assert.equal(result.status, 2);
    assert.match(result.stderr, expected);
    assert.doesNotMatch(result.stderr, /test-cookie|user:pass/);
  }
});

test('HTTPS and loopback HTTP stay allowed without the opt-in', () => {
  const https = loadConfig(gantusEnv('https://gantus.example.invalid'));
  assert.equal(https.origin, 'https://gantus.example.invalid');
  assert.equal(https.protocol, 'https:');

  const loopback = loadConfig(gantusEnv('http://127.0.0.1:3100/'));
  assert.equal(loopback.origin, 'http://127.0.0.1:3100');
  assert.equal(loopback.protocol, 'http:');
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
