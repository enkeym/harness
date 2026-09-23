#!/usr/bin/env node
// Тесты bin/ragsave-sync.sh — фонового `ragsave sync` по UserPromptSubmit и Stop.
// Бинарь подменяет fixtures/fake-indexer.mjs через AI_HOOKS_RAGSAVE_CMD либо
// симлинком $HOME/.local/bin/ragsave; HOME — песочница с симлинком на настоящий
// log-error.sh, который скрипт зовёт по пути под $HOME/.ai-hooks. Фоновый setsid
// дожидаемся по файлу вызовов фейка; отсутствие вызова проверяем после общей паузы.

import './env-isolate.mjs';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const FAKE = path.join(ROOT, 'test', 'fixtures', 'fake-indexer.mjs');
const SCRIPT = path.join(ROOT, 'bin', 'ragsave-sync.sh');

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
const git = (cwd, ...args) => spawnSync('git', args, { cwd, encoding: 'utf8' });

function sandbox({ db = true } = {}) {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ragsave-sync-')));
  const root = path.join(home, 'proj');
  fs.mkdirSync(root);
  git(root, 'init', '-q', '-b', 'main');
  const dir = path.join(root, '.ragsave');
  fs.mkdirSync(dir);
  if (db) fs.writeFileSync(path.join(dir, 'rag.db'), '');

  const bin = path.join(home, '.ai-hooks', 'bin');
  fs.mkdirSync(bin, { recursive: true });
  fs.symlinkSync(path.join(ROOT, 'bin', 'log-error.sh'), path.join(bin, 'log-error.sh'));

  const calls = path.join(home, 'calls.jsonl');
  const env = {
    ...process.env, HOME: home, AI_HOOKS_RAGSAVE_CMD: FAKE,
    AI_HOOKS_LOG_DIR: path.join(home, 'logs'), FAKE_INDEXER_CALLS: calls,
  };
  delete env.CLAUDE_PROJECT_DIR;

  // cwd по умолчанию — HOME: так запасной PWD никогда не попадает в проект случайно.
  const run = (extra = {}, args = [root], cwd = home) => {
    const e = { ...env, ...extra };
    for (const k of Object.keys(e)) if (e[k] === undefined) delete e[k];
    return spawnSync('bash', [SCRIPT, ...args], { cwd, encoding: 'utf8', env: e });
  };
  const readCalls = () => read(calls).split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const waitCalls = (n) => (waitFor(() => readCalls().length >= n), readCalls());
  const errors = () => read(path.join(home, 'logs', 'errors.log'));
  return { home, root, dir, run, readCalls, waitCalls, errors };
}

// Сценарии, где вызова быть не должно: копятся и проверяются после одной паузы —
// сломанная проверка запустила бы бинарь в фоне, уже после выхода скрипта.
const silent = [];
function expectSilent(name, sb, res, { got = () => [], want = [] } = {}) {
  silent.push({ name, got: () => [res.status, sb.readCalls(), ...got()], want: [0, [], ...want] });
}

{
  const sb = sandbox();
  const res = sb.run();
  check('код 0', res.status, 0);
  check('вызван `sync <root> --quiet`', sb.waitCalls(1), [['sync', sb.root, '--quiet']]);
  check('вывод бинаря в .ragsave/sync.log',
    waitFor(() => read(path.join(sb.dir, 'sync.log')).includes(`fake sync ${sb.root} --quiet`)), true);
  check('успех — errors.log пуст', sb.errors(), '');
}

const tmpLogs = (sb) => fs.readdirSync(sb.dir).filter((f) => f.startsWith('sync.log.'));

{
  const sb = sandbox();
  sb.run();
  check('успех — временного лога не остаётся',
    waitFor(() => read(path.join(sb.dir, 'sync.log')) !== '' && tmpLogs(sb).length === 0), true);
}

{
  const sb = sandbox();
  const log = path.join(sb.dir, 'sync.log');
  fs.writeFileSync(log, 'итог прошлого синка\n');
  sb.run({ FAKE_INDEXER_EXIT: '3' });
  sb.waitCalls(1);
  check('занятый замок — временный лог удалён', waitFor(() => tmpLogs(sb).length === 0), true);
  check('занятый замок — sync.log идущего синка не тронут', read(log), 'итог прошлого синка\n');
  check('занятый замок — errors.log пуст', sb.errors(), '');
}

{
  const sb = sandbox();
  sb.run({ FAKE_INDEXER_EXIT: '1' });
  check('отказ бинаря — запись в errors.log',
    waitFor(() => sb.errors().includes(`] ragsave sync | ${sb.root} | exit=1`)), true);
  check('отказ бинаря — хвост sync.log в записи', sb.errors().includes(`    fake sync ${sb.root} --quiet`), true);
  check('отказ бинаря — лог остаётся в sync.log для last_sync',
    waitFor(() => read(path.join(sb.dir, 'sync.log')).includes('fake sync')), true);
}

{
  const sb = sandbox();
  const local = path.join(sb.home, '.local', 'bin');
  fs.mkdirSync(local, { recursive: true });
  fs.symlinkSync(FAKE, path.join(local, 'ragsave'));
  sb.run({ AI_HOOKS_RAGSAVE_CMD: undefined });
  check('без AI_HOOKS_RAGSAVE_CMD — $HOME/.local/bin/ragsave', sb.waitCalls(1), [['sync', sb.root, '--quiet']]);
}

{
  const sb = sandbox();
  fs.mkdirSync(path.join(sb.root, 'sub'));
  sb.run({}, [path.join(sb.root, 'sub')]);
  check('подкаталог — sync от корня репозитория', sb.waitCalls(1), [['sync', sb.root, '--quiet']]);
}

{
  const sb = sandbox();
  sb.run({ CLAUDE_PROJECT_DIR: sb.root }, []);
  check('без аргумента — CLAUDE_PROJECT_DIR', sb.waitCalls(1), [['sync', sb.root, '--quiet']]);
}

{
  const sb = sandbox();
  sb.run({}, [], sb.root);
  check('без аргумента и CLAUDE_PROJECT_DIR — PWD', sb.waitCalls(1), [['sync', sb.root, '--quiet']]);
}

{
  const sb = sandbox({ db: false });
  expectSilent('без .ragsave/rag.db — ни вызова, ни sync.log', sb, sb.run(),
    { got: () => [fs.existsSync(path.join(sb.dir, 'sync.log'))], want: [false] });
}

{
  const sb = sandbox();
  fs.writeFileSync(path.join(sb.root, '.ragsave-disable'), '');
  expectSilent('.ragsave-disable', sb, sb.run());
}

{
  const sb = sandbox();
  git(sb.home, 'init', '-q');
  fs.mkdirSync(path.join(sb.home, '.ragsave'));
  fs.writeFileSync(path.join(sb.home, '.ragsave', 'rag.db'), '');
  fs.mkdirSync(path.join(sb.home, 'sub'));
  expectSilent('каталог проекта — сам $HOME', sb, sb.run({}, [sb.home]));
  expectSilent('git-корень — $HOME', sb, sb.run({}, [path.join(sb.home, 'sub')]));
}

{
  const sb = sandbox();
  const plain = path.join(sb.home, 'plain');
  fs.mkdirSync(path.join(plain, '.ragsave'), { recursive: true });
  fs.writeFileSync(path.join(plain, '.ragsave', 'rag.db'), '');
  expectSilent('не git-репозиторий', sb, sb.run({}, [plain]));
}

{
  const sb = sandbox();
  const res = sb.run({ AI_HOOKS_RAGSAVE_CMD: '/nonexistent/ragsave' });
  expectSilent('бинаря нет — ни лога, ни записи в errors.log', sb, res,
    { got: () => [fs.existsSync(path.join(sb.dir, 'sync.log')), sb.errors()], want: [false, ''] });
}

// --- сценарии без вызова: одна пауза на всех ---
sleep(1000);
for (const { name, got, want } of silent) check(name, got(), want);

process.stdout.write(failed ? `\n=== ${failed} проверок упало ===\n` : '\n=== все проверки прошли ===\n');
process.exit(failed ? 1 : 0);
