#!/usr/bin/env node
// Тесты фоновых скриптов tokensave: bin/tokensave-sync.sh (sync по Stop),
// bin/tokensave-branch.sh (branch add для новой ветки) и
// bin/tokensave-branch-prune.sh (чистка устаревших веток раз в сутки).
// Бинарь подменяет fixtures/fake-indexer.mjs через AI_HOOKS_TOKENSAVE_CMD,
// HOME — песочница с симлинками на настоящие log-error.sh и prune, которые
// скрипты зовут по пути под $HOME/.ai-hooks. Фоновый setsid дожидаемся по
// файлу вызовов фейка; отсутствие вызова проверяем после общей паузы.

import './env-isolate.mjs';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const FAKE = path.join(ROOT, 'test', 'fixtures', 'fake-indexer.mjs');
const DAY = 86400;

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

function sandbox({ db = true, branch = 'main', meta, stamp } = {}) {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tokensave-sync-')));
  const root = path.join(home, 'proj');
  fs.mkdirSync(root);
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'symbolic-ref', 'HEAD', `refs/heads/${branch}`);
  const dir = path.join(root, '.tokensave');
  fs.mkdirSync(dir);
  if (db) fs.writeFileSync(path.join(dir, 'tokensave.db'), '');
  if (meta) fs.writeFileSync(path.join(dir, 'branch-meta.json'), JSON.stringify(meta));
  const stampFile = path.join(dir, '.branch-prune-stamp');
  if (stamp) {
    fs.writeFileSync(stampFile, '');
    const at = Date.now() / 1000 - stamp;
    fs.utimesSync(stampFile, at, at);
  }

  const bin = path.join(home, '.ai-hooks', 'bin');
  fs.mkdirSync(bin, { recursive: true });
  for (const f of ['log-error.sh', 'tokensave-branch-prune.sh']) fs.symlinkSync(path.join(ROOT, 'bin', f), path.join(bin, f));

  const calls = path.join(home, 'calls.jsonl');
  const env = {
    ...process.env, HOME: home, AI_HOOKS_TOKENSAVE_CMD: FAKE,
    AI_HOOKS_LOG_DIR: path.join(home, 'logs'), FAKE_INDEXER_CALLS: calls,
  };
  delete env.CLAUDE_PROJECT_DIR;
  delete env.TOKENSAVE_BRANCH_TTL_DAYS;

  const run = (script, extra = {}, args = [root]) =>
    spawnSync('bash', [path.join(ROOT, 'bin', script), ...args], { encoding: 'utf8', env: { ...env, ...extra } });
  const readCalls = () => read(calls).split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const waitCalls = (n) => (waitFor(() => readCalls().length >= n), readCalls());
  const errors = () => read(path.join(home, 'logs', 'errors.log'));
  // Лок синка держит отдельный процесс, пока тест не вызовет release().
  const holdLock = () => {
    const ready = path.join(home, 'lock-ready');
    const holder = spawn('flock', [path.join(dir, '.sync.lock'), 'sh', '-c', `touch '${ready}'; sleep 30`], { detached: true, stdio: 'ignore' });
    holder.unref();
    waitFor(() => fs.existsSync(ready));
    return () => process.kill(-holder.pid);
  };
  return { home, root, dir, stampFile, run, readCalls, waitCalls, errors, holdLock };
}

// Сценарии, где вызова быть не должно: копятся и проверяются после одной паузы —
// сломанная проверка запустила бы бинарь в фоне, уже после выхода скрипта.
// only — какие вызовы считать лишними; got/want — дополнительные проверки.
const silent = [];
function expectSilent(name, sb, res, { only = () => true, got = () => [], want = [] } = {}) {
  silent.push({ name, got: () => [res.status, sb.readCalls().filter(only), ...got()], want: [0, [], ...want] });
}

// === tokensave-sync.sh ===

{
  const sb = sandbox();
  const res = sb.run('tokensave-sync.sh');
  check('sync: код 0', res.status, 0);
  check('sync: вызван `sync <root>`', sb.waitCalls(1), [['sync', sb.root]]);
  check('sync: вывод бинаря в .tokensave/sync.log',
    waitFor(() => read(path.join(sb.dir, 'sync.log')).includes(`fake sync ${sb.root}`)), true);
  check('sync: успех — errors.log пуст', sb.errors(), '');
}

{
  const sb = sandbox();
  sb.run('tokensave-sync.sh', { FAKE_INDEXER_EXIT: '3' });
  check('sync: отказ бинаря — запись в errors.log',
    waitFor(() => sb.errors().includes(`] tokensave sync | ${sb.root} | exit=3`)), true);
}

{
  const sb = sandbox({ db: false });
  expectSilent('sync: без БД', sb, sb.run('tokensave-sync.sh'));
}

{
  const sb = sandbox();
  fs.writeFileSync(path.join(sb.root, '.tokensave-disable'), '');
  expectSilent('sync: .tokensave-disable', sb, sb.run('tokensave-sync.sh'));
}

{
  const sb = sandbox();
  git(sb.home, 'init', '-q');
  fs.mkdirSync(path.join(sb.home, '.tokensave'));
  fs.writeFileSync(path.join(sb.home, '.tokensave', 'tokensave.db'), '');
  fs.mkdirSync(path.join(sb.home, 'sub'));
  expectSilent('sync: каталог проекта — сам $HOME', sb, sb.run('tokensave-sync.sh', {}, [sb.home]));
  expectSilent('sync: git-корень — $HOME', sb, sb.run('tokensave-sync.sh', {}, [path.join(sb.home, 'sub')]));
}

{
  const sb = sandbox();
  const plain = path.join(sb.home, 'plain');
  fs.mkdirSync(path.join(plain, '.tokensave'), { recursive: true });
  fs.writeFileSync(path.join(plain, '.tokensave', 'tokensave.db'), '');
  expectSilent('sync: не git-репозиторий', sb, sb.run('tokensave-sync.sh', {}, [plain]));
}

{
  const sb = sandbox();
  const res = sb.run('tokensave-sync.sh', { AI_HOOKS_TOKENSAVE_CMD: '/nonexistent/tokensave' });
  expectSilent('sync: бинаря нет — ни лога, ни записи в errors.log', sb, res,
    { got: () => [fs.existsSync(path.join(sb.dir, 'sync.log')), sb.errors()], want: [false, ''] });
}

{
  const sb = sandbox();
  const release = sb.holdLock();
  const res = sb.run('tokensave-sync.sh');
  sleep(300);
  // Лок отпускаем до общей паузы: sync, который ждёт лок вместо пропуска, успеет отработать и попасться.
  release();
  expectSilent('sync: идёт другой sync — пропуск, а не ожидание', sb, res);
}

// === tokensave-branch.sh ===
// Свежая отметка prune (stamp: 60 с) глушит чистку там, где проверяется только branch add.

const tracked = { default_branch: 'main', branches: { main: {} } };

{
  const sb = sandbox({ branch: 'feat', meta: tracked, stamp: 60 });
  const res = sb.run('tokensave-branch.sh');
  check('branch: код 0', res.status, 0);
  check('branch: новая ветка — branch add, затем branch gc', sb.waitCalls(2),
    [['branch', 'add', 'feat', '-p', sb.root], ['branch', 'gc', '-p', sb.root]]);
}

{
  const sb = sandbox({ branch: 'feat', stamp: 60 });
  sb.run('tokensave-branch.sh');
  check('branch: branch-meta.json ещё нет — ветка новая', sb.waitCalls(1)[0], ['branch', 'add', 'feat', '-p', sb.root]);
}

{
  const sb = sandbox({ branch: 'feat', meta: tracked, stamp: 60 });
  sb.run('tokensave-branch.sh', { FAKE_INDEXER_EXIT: '2' });
  check('branch: отказы add и gc — обе записи в errors.log',
    waitFor(() => sb.errors().includes(`] tokensave branch add | ${sb.root} | exit=2`)
      && sb.errors().includes(`] tokensave branch gc | ${sb.root} | exit=2`)), true);
}

{
  const sb = sandbox({ branch: 'feat', meta: tracked, stamp: 60 });
  const release = sb.holdLock();
  sb.run('tokensave-branch.sh');
  sleep(800);
  check('branch: лок занят — ждёт, а не пропускает', sb.readCalls(), []);
  release();
  check('branch: лок свободен — branch add выполнен', sb.waitCalls(1)[0], ['branch', 'add', 'feat', '-p', sb.root]);
}

{
  const sb = sandbox({ meta: tracked, stamp: 60 });
  expectSilent('branch: ветка уже отслеживается', sb, sb.run('tokensave-branch.sh'));
}

{
  const sb = sandbox({ branch: 'feat', meta: tracked, stamp: 60, db: false });
  expectSilent('branch: без БД', sb, sb.run('tokensave-branch.sh'));
}

{
  const sb = sandbox({ branch: 'feat', meta: tracked, stamp: 60 });
  fs.writeFileSync(path.join(sb.root, '.tokensave-disable'), '');
  expectSilent('branch: .tokensave-disable', sb, sb.run('tokensave-branch.sh'));
}

{
  const sb = sandbox({ meta: tracked });
  const res = sb.run('tokensave-branch.sh');
  check('branch: отслеживаемая ветка — prune всё равно запущен', sb.waitCalls(1), [['branch', 'gc', '-p', sb.root]]);
  expectSilent('branch: отслеживаемая ветка — кроме prune ничего', sb, res, { only: (c) => c[1] !== 'gc' });
}

{
  const sb = sandbox({ meta: tracked });
  git(sb.root, '-c', 'user.name=t', '-c', 'user.email=t@example.test', 'commit', '-q', '--allow-empty', '-m', 'init');
  git(sb.root, 'checkout', '-q', '--detach');
  const res = sb.run('tokensave-branch.sh');
  check('branch: detached HEAD — prune запущен', sb.waitCalls(1), [['branch', 'gc', '-p', sb.root]]);
  expectSilent('branch: detached HEAD — без branch add', sb, res, { only: (c) => c[1] !== 'gc' });
}

// === tokensave-branch-prune.sh ===

function pruneMeta(now = Date.now() / 1000) {
  return {
    default_branch: 'main',
    branches: {
      main: { last_synced_at: now - 90 * DAY },
      cur: { last_synced_at: now - 90 * DAY },
      stale: { last_synced_at: now - 30 * DAY },
      mid: { created_at: now - 10 * DAY },
      fresh: { last_synced_at: now - DAY },
      never: {},
      broken: { last_synced_at: 'вчера' },
    },
  };
}

// После последнего ожидаемого вызова — короткая пауза: лишний remove пришёл бы следом.
const settled = (sb, n) => (sb.waitCalls(n), sleep(300), sb.readCalls());

{
  const sb = sandbox({ branch: 'cur', meta: pruneMeta() });
  const res = sb.run('tokensave-branch-prune.sh');
  check('prune: код 0', res.status, 0);
  check('prune: gc, затем remove только старше 21 дня; текущая, по умолчанию, без даты — целы',
    settled(sb, 2), [['branch', 'gc', '-p', sb.root], ['branch', 'remove', 'stale', '-p', sb.root]]);
  check('prune: отметка поставлена', fs.existsSync(sb.stampFile), true);
}

{
  const sb = sandbox({ branch: 'cur', meta: pruneMeta() });
  sb.run('tokensave-branch-prune.sh', { TOKENSAVE_BRANCH_TTL_DAYS: '5' });
  check('prune: TOKENSAVE_BRANCH_TTL_DAYS=5 — уходит и 10-дневная (по created_at)',
    settled(sb, 3).filter((c) => c[1] === 'remove').map((c) => c[2]).sort(), ['mid', 'stale']);
}

{
  const sb = sandbox({ branch: 'cur', meta: pruneMeta(), stamp: 2 * DAY });
  sb.run('tokensave-branch-prune.sh');
  check('prune: отметка старше суток — чистка идёт', settled(sb, 2).length, 2);
}

{
  const sb = sandbox({ branch: 'cur', meta: pruneMeta() });
  sb.run('tokensave-branch-prune.sh', { FAKE_INDEXER_EXIT: '4' });
  check('prune: отказ remove — запись в errors.log',
    waitFor(() => sb.errors().includes(`] tokensave branch remove | ${sb.root} | exit=4`)), true);
  check('prune: отказ gc в errors.log не пишется', sb.errors().includes('tokensave branch gc'), false);
}

{
  const sb = sandbox({ branch: 'cur', meta: pruneMeta(), stamp: 3600 });
  expectSilent('prune: отметка моложе суток', sb, sb.run('tokensave-branch-prune.sh'));
}

{
  const sb = sandbox({ branch: 'cur' });
  expectSilent('prune: без branch-meta.json — отметки нет', sb, sb.run('tokensave-branch-prune.sh'),
    { got: () => [fs.existsSync(sb.stampFile)], want: [false] });
}

{
  const sb = sandbox({ branch: 'cur', meta: pruneMeta() });
  const res = sb.run('tokensave-branch-prune.sh', { AI_HOOKS_TOKENSAVE_CMD: '/nonexistent/tokensave' });
  expectSilent('prune: бинаря нет — отметки нет', sb, res, { got: () => [fs.existsSync(sb.stampFile)], want: [false] });
}

// --- сценарии без вызова: одна пауза на всех ---
sleep(1000);
for (const { name, got, want } of silent) check(name, got(), want);

process.stdout.write(failed ? `\n=== ${failed} проверок упало ===\n` : '\n=== все проверки прошли ===\n');
process.exit(failed ? 1 : 0);
