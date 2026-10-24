#!/usr/bin/env node
// Тесты bin/project-init.sh — достройки недостающего индекса проекта.
// Бинари подменяют симлинки tokensave/ragsave на fixtures/fake-init.mjs через
// AI_HOOKS_TOKENSAVE_CMD / AI_HOOKS_RAGSAVE_CMD; HOME, журналы и замки — в
// песочнице. Шаги гоняются на переднем плане (без --detach) — порядок вызовов
// виден сразу; фоновый запуск дожидаемся по файлу вызовов.

import './env-isolate.mjs';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const FAKE = path.join(ROOT, 'test', 'fixtures', 'fake-init.mjs');
const SCRIPT = path.join(ROOT, 'bin', 'project-init.sh');

let failed = 0;
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  process.stdout.write(`${ok ? 'ok  ' : 'FAIL'} ${name} (got=${JSON.stringify(got)}, want=${JSON.stringify(want)})\n`);
  if (!ok) failed++;
}

const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
function waitFor(pred, ms = 5000) {
  const end = Date.now() + ms;
  while (Date.now() < end && !pred()) sleep(50);
  return pred();
}
const read = (file) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '');

function sandbox() {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'project-init-')));
  const root = path.join(home, 'proj');
  fs.mkdirSync(root);
  spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: root });

  const bin = path.join(home, 'bin');
  fs.mkdirSync(bin);
  for (const name of ['tokensave', 'ragsave']) fs.symlinkSync(FAKE, path.join(bin, name));

  const calls = path.join(home, 'calls.jsonl');
  const logs = path.join(home, 'logs');
  const state = path.join(home, 'state');
  const env = {
    ...process.env, HOME: home,
    AI_HOOKS_TOKENSAVE_CMD: path.join(bin, 'tokensave'), AI_HOOKS_RAGSAVE_CMD: path.join(bin, 'ragsave'),
    AI_HOOKS_LOG_DIR: logs, AI_HOOKS_STATE_DIR: state, FAKE_INIT_CALLS: calls,
  };
  const run = (extra = {}, args = [root]) => spawnSync('bash', [SCRIPT, ...args], { cwd: home, encoding: 'utf8', env: { ...env, ...extra } });
  const readCalls = () => read(calls).split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const errors = () => read(path.join(logs, 'errors.log'));
  const key = createHash('sha256').update(root).digest('hex').slice(0, 16);
  const lock = path.join(state, 'project-init', `${key}.lock`);
  const touch = (...p) => {
    fs.mkdirSync(path.join(root, ...p.slice(0, -1)), { recursive: true });
    fs.writeFileSync(path.join(root, ...p), '');
  };
  return { home, root, logs, run, readCalls, errors, lock, touch };
}

const TS_INIT = (root) => ['tokensave', 'init', root, '--no-git-hook', '--cpu-usage', 'low'];
const RAG_INIT = (root) => ['ragsave', 'init', root, '--quiet'];

{
  const sb = sandbox();
  const res = sb.run();
  check('нет обоих индексов — tokensave, затем ragsave', [res.status, sb.readCalls()], [0, [TS_INIT(sb.root), RAG_INIT(sb.root)]]);
  check('успех — errors.log пуст', sb.errors(), '');
  check('после прогона замок снят', fs.existsSync(sb.lock), false);
  check('ход в project-init.log', read(path.join(sb.logs, 'project-init.log')).match(/\| (\w+ init: [\w=]+)/g),
    ['| tokensave init: start', '| tokensave init: exit=0', '| ragsave init: start', '| ragsave init: exit=0']);
  sb.run();
  check('повторный прогон — ни одного вызова', sb.readCalls().length, 2);
}

{
  const sb = sandbox();
  sb.touch('.tokensave', 'tokensave.db');
  sb.run();
  check('есть .tokensave — только ragsave', sb.readCalls(), [RAG_INIT(sb.root)]);
}

{
  const sb = sandbox();
  sb.touch('.ragsave', 'rag.db');
  sb.run();
  check('есть .ragsave — только tokensave', sb.readCalls(), [TS_INIT(sb.root)]);
}

{
  const sb = sandbox();
  sb.touch('.ragsave-disable');
  sb.run();
  check('.ragsave-disable — ragsave не вызван', sb.readCalls(), [TS_INIT(sb.root)]);
}

{
  const sb = sandbox();
  sb.touch('.tokensave', 'tokensave.db');
  sb.touch('.tokensave', 'dirty');
  sb.touch('.ragsave', 'rag.db');
  sb.run();
  check('прерванный tokensave init (dirty) — sync', sb.readCalls(), [['tokensave', 'sync', sb.root]]);
}

{
  const sb = sandbox();
  fs.mkdirSync(sb.lock, { recursive: true });
  fs.writeFileSync(path.join(sb.lock, 'pid'), `${process.pid}\n`);
  sb.run();
  check('замок живого прогона — выход без вызовов', sb.readCalls(), []);
  check('чужой замок не снят', fs.existsSync(sb.lock), true);
}

{
  const sb = sandbox();
  const dead = spawnSync('true').pid;
  fs.mkdirSync(sb.lock, { recursive: true });
  fs.writeFileSync(path.join(sb.lock, 'pid'), `${dead}\n`);
  sb.run();
  check('замок мёртвого pid — прогон идёт', sb.readCalls().length, 2);
}

{
  const sb = sandbox();
  fs.mkdirSync(sb.lock, { recursive: true });
  fs.writeFileSync(path.join(sb.lock, 'pid'), `${process.pid}\n`);
  const old = new Date(Date.now() - 25 * 3600 * 1000);
  fs.utimesSync(sb.lock, old, old);
  sb.run();
  check('замок старше суток — прогон идёт', sb.readCalls().length, 2);
}

{
  const sb = sandbox();
  sb.run({ FAKE_INIT_FAIL: 'tokensave' });
  check('сбой tokensave — ragsave всё равно идёт', sb.readCalls(), [TS_INIT(sb.root), RAG_INIT(sb.root)]);
  check('сбой tokensave — запись в errors.log', sb.errors().includes(`] tokensave init | ${sb.root} | exit=1`), true);
  check('сбой tokensave — хвост вывода в записи', sb.errors().includes(`    fake tokensave init ${sb.root}`), true);
  check('сбой tokensave — временного файла не остаётся',
    fs.readdirSync(sb.logs).filter((f) => f.endsWith('.out')), []);
}

{
  const sb = sandbox();
  const res = sb.run({}, ['--detach', sb.root]);
  check('--detach — код 0 и строка про оба индекса',
    [res.status, res.stderr.includes('индекс tokensave и ragsave строится в фоне')], [0, true]);
  check('--detach — шаги идут в фоне', waitFor(() => sb.readCalls().length === 2) && sb.readCalls(),
    [TS_INIT(sb.root), RAG_INIT(sb.root)]);
  check('--detach — фон снял замок', waitFor(() => !fs.existsSync(sb.lock)), true);
}

{
  const sb = sandbox();
  sb.touch('.tokensave', 'tokensave.db');
  sb.touch('.ragsave', 'rag.db');
  const res = sb.run({}, ['--detach', sb.root]);
  check('--detach, оба индекса есть — молчит', [res.status, res.stderr], [0, '']);
}

{
  const sb = sandbox();
  fs.mkdirSync(path.join(sb.root, 'sub'));
  sb.run({}, [path.join(sb.root, 'sub')]);
  check('подкаталог — шаги от корня репозитория', sb.readCalls(), [TS_INIT(sb.root), RAG_INIT(sb.root)]);
}

{
  const sb = sandbox();
  const plain = path.join(sb.home, 'plain');
  fs.mkdirSync(plain);
  sb.run({}, [plain]);
  sb.run({}, [sb.home]);
  check('не git-каталог и $HOME — без вызовов', sb.readCalls(), []);
}

{
  const sb = sandbox();
  const res = sb.run({ AI_HOOKS_TOKENSAVE_CMD: '/nonexistent/tokensave', AI_HOOKS_RAGSAVE_CMD: '/nonexistent/ragsave' }, ['--detach', sb.root]);
  check('бинарей нет — молчит, errors.log пуст', [res.status, res.stderr, sb.errors()], [0, '', '']);
}

process.stdout.write(failed ? `\n=== ${failed} проверок упало ===\n` : '\n=== все проверки прошли ===\n');
process.exit(failed ? 1 : 0);
