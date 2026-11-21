import './env-isolate.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { registerFirstResponse } from '../../opencode/first-response.mjs';

const hooksRoot = fileURLToPath(new URL('../', import.meta.url));
const script = path.join(hooksRoot, 'bin/count-first-response.sh');

async function fixture(directory = '/project') {
  const handlers = {};
  const records = [];
  const context = {
    session: {
      hook: async (name, handler) => {
        (handlers[name] ??= []).push(handler);
      }
    }
  };
  await registerFirstResponse(context, directory, (dir, ms) => records.push({ dir, ms }));
  const fire = async (name, event) => {
    for (const handler of handlers[name] ?? []) await handler(event);
  };
  return { records, fire };
}

function sandbox(t) {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'first-response-')));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const counterDir = path.join(home, 'counters');
  const env = { ...process.env, HOME: home, AI_HOOKS_COUNTER_DIR: counterDir };
  const run = (dir, ms) => {
    const result = spawnSync('bash', [script, dir, ms], { env, encoding: 'utf8', timeout: 10000 });
    assert.deepEqual([result.status, result.stdout, result.stderr], [0, '', '']);
  };
  const counters = () => {
    const files = fs.existsSync(counterDir) ? fs.readdirSync(counterDir) : [];
    return {
      files,
      lines: files.map((name) =>
        fs.readFileSync(path.join(counterDir, name), 'utf8').trim().split('\n').filter(Boolean))
    };
  };
  return { home, run, counters, counterDir };
}

test('первый primary-ответ после промпта измеряется один раз', async () => {
  const f = await fixture();
  await f.fire('prompt', { sessionID: 'ses_a' });
  await f.fire('http.response', { sessionID: 'ses_a', kind: 'primary' });
  assert.equal(f.records.length, 1);
  assert.equal(f.records[0].dir, '/project');
  assert.ok(Number.isInteger(f.records[0].ms) && f.records[0].ms >= 0);
  await f.fire('http.response', { sessionID: 'ses_a', kind: 'primary' });
  assert.equal(f.records.length, 1);
});

test('вспомогательные kind, чужая сессия и ответ без промпта не измеряются', async () => {
  const f = await fixture();
  await f.fire('http.response', { sessionID: 'ses_x', kind: 'primary' });
  await f.fire('prompt', { sessionID: 'ses_a' });
  for (const kind of ['title', 'compaction', 'generate']) {
    await f.fire('http.response', { sessionID: 'ses_a', kind });
  }
  await f.fire('http.response', { sessionID: 'ses_b', kind: 'primary' });
  assert.equal(f.records.length, 0);
  await f.fire('http.response', { sessionID: 'ses_a' });
  assert.equal(f.records.length, 1);
});

test('новый промпт снова включает замер, две сессии независимы', async () => {
  const f = await fixture();
  await f.fire('prompt', { sessionID: 'ses_a' });
  await f.fire('prompt', { sessionID: 'ses_b' });
  await f.fire('http.response', { sessionID: 'ses_b', kind: 'primary' });
  await f.fire('http.response', { sessionID: 'ses_a', kind: 'primary' });
  await f.fire('http.response', { sessionID: 'ses_a', kind: 'primary' });
  assert.equal(f.records.length, 2);
  await f.fire('prompt', { sessionID: 'ses_a' });
  await f.fire('http.response', { sessionID: 'ses_a', kind: 'primary' });
  assert.equal(f.records.length, 3);
});

test('first-response-ms пишется в счётчик канонического корня, симлинк не плодит ключ', (t) => {
  const sb = sandbox(t);
  const root = path.join(sb.home, 'project');
  fs.mkdirSync(path.join(root, '.tokensave'), { recursive: true });
  fs.writeFileSync(path.join(root, '.tokensave/tokensave.db'), '');
  const link = path.join(sb.home, 'project-link');
  fs.symlinkSync(root, link);
  sb.run(root, '1234');
  sb.run(link, '56');
  const { files, lines } = sb.counters();
  assert.equal(files.length, 1);
  assert.equal(lines[0].length, 2);
  for (const [line, ms] of [[lines[0][0], '1234'], [lines[0][1], '56']]) {
    const parts = line.split(' ');
    assert.equal(parts.length, 3);
    assert.match(parts[0], /^\d+$/);
    assert.equal(parts[1], 'first-response-ms');
    assert.equal(parts[2], ms);
  }
});

test('корень ragsave находится, без индекса ключ — физический каталог', (t) => {
  const sb = sandbox(t);
  const rag = path.join(sb.home, 'rag');
  fs.mkdirSync(path.join(rag, '.ragsave'), { recursive: true });
  fs.writeFileSync(path.join(rag, '.ragsave/rag.db'), '');
  sb.run(rag, '5');
  const plain = path.join(sb.home, 'plain');
  fs.mkdirSync(plain);
  sb.run(plain, '7');
  const { files, lines } = sb.counters();
  assert.equal(files.length, 2);
  assert.deepEqual(lines.map((entry) => entry.length), [1, 1]);
});

test('пустой ms, HOME и отсутствующий каталог счётчик не пишут', (t) => {
  const sb = sandbox(t);
  const plain = path.join(sb.home, 'plain');
  fs.mkdirSync(plain);
  sb.run(plain, '');
  sb.run(sb.home, '10');
  sb.run(path.join(sb.home, 'missing'), '10');
  assert.equal(fs.existsSync(sb.counterDir), false);
});
