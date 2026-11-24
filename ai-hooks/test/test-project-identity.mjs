#!/usr/bin/env node
import './env-isolate.mjs';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SCRIPT = path.join(ROOT, '..', 'bin', 'project-identity.mjs');
const INDEX = { tokensave: ['.tokensave', 'tokensave.db'], ragsave: ['.ragsave', 'rag.db'] };

let failed = 0;
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  process.stdout.write(`${ok ? 'ok  ' : 'FAIL'} ${name} (got=${JSON.stringify(got)}, want=${JSON.stringify(want)})\n`);
  if (!ok) failed++;
}
const checkOk = (name, cond) => check(name, Boolean(cond), true);

const read = (file) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '');
const lines = (file) => read(file).split('\n').filter(Boolean);

function index(dir, kind) {
  const [sub, db] = INDEX[kind];
  fs.mkdirSync(path.join(dir, sub), { recursive: true });
  fs.writeFileSync(path.join(dir, sub, db), '');
}

async function seedTokenSave(dir, paths, dbFile = 'tokensave.db') {
  let DatabaseSync;
  const warningListeners = process.rawListeners('warning');
  process.removeAllListeners('warning');
  try { ({ DatabaseSync } = await import('node:sqlite')); } finally {
    for (const listener of warningListeners) process.on('warning', listener);
  }
  fs.mkdirSync(path.dirname(path.join(dir, '.tokensave', dbFile)), { recursive: true });
  const db = new DatabaseSync(path.join(dir, '.tokensave', dbFile));
  db.exec('create table if not exists files (path text primary key)');
  const insert = db.prepare('insert or replace into files (path) values (?)');
  for (const file of paths) insert.run(file);
  db.close();
}

function sandbox({ indexes = ['tokensave', 'ragsave'], servers = 'No tokensave servers running.' } = {}) {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'project-identity-')));
  const root = path.join(home, 'proj');
  fs.mkdirSync(root, { recursive: true });
  check('git init', spawnSync('git', ['init', '-q', root]).status, 0);
  for (const kind of indexes) index(root, kind);
  check('git commit', spawnSync('git', ['-C', root, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init']).status, 0);
  const headCt = Number(spawnSync('git', ['-C', root, 'log', '-1', '--format=%ct'], { encoding: 'utf8' }).stdout.trim());

  const bin = path.join(home, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  const ts = path.join(bin, 'tokensave');
  const rg = path.join(bin, 'ragsave');
  fs.writeFileSync(ts, [
    '#!/usr/bin/env bash',
    'echo "tokensave $*" >> "$FAKE_CALLS"',
    'if [ "$1" = status ] && [ "${2:-}" = -j ]; then cat "$FAKE_TS_JSON";',
    'elif [ "$1" = status ]; then cat "$FAKE_TS_STATUS";',
    'else cat "$FAKE_TS_SERVERS"; fi'
  ].join('\n'));
  fs.writeFileSync(rg, [
    '#!/usr/bin/env bash',
    'echo "ragsave $1" >> "$FAKE_CALLS"',
    '[ "$1" = status ] && cat "$FAKE_RG_STATUS"'
  ].join('\n'));
  fs.chmodSync(ts, 0o755);
  fs.chmodSync(rg, 0o755);

  const calls = path.join(home, 'calls.log');
  const tsStatus = path.join(home, 'ts-status.txt');
  const tsJson = path.join(home, 'ts-status.json');
  const rgStatus = path.join(home, 'rg-status.json');
  const tsServers = path.join(home, 'ts-servers.txt');
  fs.writeFileSync(tsServers, `${servers}\n`);
  fs.writeFileSync(tsStatus, `│ Project: ${root} │\n│ Branch: [single-db] │\n`);
  const setTsJson = (fields) => fs.writeFileSync(tsJson, `${JSON.stringify({
    last_sync_at: headCt + 300,
    last_updated: headCt + 300,
    ...fields
  })}\n`);
  setTsJson({});
  fs.writeFileSync(rgStatus, `${JSON.stringify({
    project: root,
    db: path.join(root, '.ragsave', 'rag.db'),
    files: 10,
    indexed: true,
    autosync: 'ok',
    last_sync: { at: '2026-11-20 00:00:00' }
  })}\n`);

  const env = {
    ...process.env,
    HOME: home,
    AI_HOOKS_TOKENSAVE_CMD: ts,
    AI_HOOKS_RAGSAVE_CMD: rg,
    FAKE_CALLS: calls,
    FAKE_TS_STATUS: tsStatus,
    FAKE_TS_SERVERS: tsServers,
    FAKE_TS_JSON: tsJson,
    FAKE_RG_STATUS: rgStatus,
    PLAYWRIGHT_MCP_EXTENSION_TOKEN: 'test-token'
  };
  const run = (dir) => {
    const res = spawnSync(process.execPath, [SCRIPT, dir], { encoding: 'utf8', env, timeout: 30000 });
    return { status: res.status, out: res.stdout + res.stderr, calls: lines(calls) };
  };
  return { home, root, headCt, run, tsStatus, setTsJson, setServers: (text) => fs.writeFileSync(tsServers, `${text}\n`) };
}

{
  const sb = sandbox();
  const res = sb.run(sb.root);
  check('согласованная идентичность: код 0', res.status, 0);
  checkOk('показан ожидаемый реальный путь', res.out.includes(sb.root));
  checkOk('показан Git worktree и ветка', res.out.includes('Git worktree') && /ветка: \S+/.test(res.out));
  checkOk('показаны оба маркера', res.out.includes('.tokensave/tokensave.db') && res.out.includes('.ragsave/rag.db'));
  checkOk('показан фактический путь backend', res.out.includes('фактический реальный путь backend'));
  checkOk('свежий индекс отмечен ✓', res.out.includes('индекс свежий'));
  checkOk('Playwright проверен отдельно', res.out.includes('Playwright') && res.out.includes('PLAYWRIGHT_MCP_EXTENSION_TOKEN задан'));
  check('backend вызван только для статуса', res.calls, ['tokensave status', 'tokensave status -j', 'tokensave servers', 'ragsave status']);
}

{
  const sb = sandbox({
    servers: [
      '   PID  VERSION  PROJECT',
      '560899   7.17.3  /home/korolev/harness',
      '                 └─ db: /home/korolev/harness/.tokensave/branches/dev.db'
    ].join('\n')
  });
  const res = sb.run(sb.root);
  checkOk('показана строка запущенного сервера, а не заголовок таблицы', res.out.includes('запущенные серверы: 1, 560899') && !res.out.includes('запущенные серверы: PID'));
  sb.setServers('No tokensave servers running.');
  const idle = sb.run(sb.root);
  checkOk('без запущенных серверов строки о серверах нет', !idle.out.includes('запущенные серверы'));
}

{
  const sb = sandbox();
  fs.writeFileSync(sb.tsStatus, `│ Project: ${path.join(sb.home, 'other')} │\n│ Branch: [single-db] │\n`);
  const res = sb.run(sb.root);
  check('чужой проект backend: код 1', res.status, 1);
  checkOk('несовпадение помечено ✗', res.out.includes('✗') && res.out.includes('другой проект'));
}

{
  const sb = sandbox();
  sb.setTsJson({ last_sync_at: sb.headCt - 100, last_updated: sb.headCt - 100 });
  const res = sb.run(sb.root);
  check('отставание по содержимому: код 0', res.status, 0);
  checkOk('отставание помечено ! с советом sync', res.out.includes('отставание по содержимому') && res.out.includes('tokensave sync'));
}

{
  const sb = sandbox();
  sb.setTsJson({ last_sync_at: sb.headCt + 100, last_updated: sb.headCt - 100 });
  const res = sb.run(sb.root);
  check('подозрение по commit timestamp: код 0', res.status, 0);
  checkOk('подозрение помечено ! без цикла sync', res.out.includes('подозрение по commit timestamp') && res.out.includes('не повторяйте sync циклом'));
  check('диагностика не запускает sync', res.calls.filter((c) => c === 'tokensave sync').length, 0);
}

{
  const sb = sandbox();
  const inner = path.join(sb.root, 'inner');
  fs.mkdirSync(inner);
  check('git init inner', spawnSync('git', ['init', '-q', inner]).status, 0);
  const res = sb.run(inner);
  check('вложенный Git без индекса: код 0', res.status, 0);
  checkOk('индекс не найден, backend не запускался', res.out.includes('не найден') && res.calls.length === 0);
}

{
  const sb = sandbox();
  const link = path.join(sb.home, 'alias');
  fs.symlinkSync(sb.root, link);
  const direct = sb.run(sb.root);
  const viaLink = sb.run(link);
  check('симлинк: тот же код, что прямой путь', viaLink.status, direct.status);
  checkOk('симлинк: показан реальный путь, а не alias', viaLink.out.includes(sb.root) && !viaLink.out.includes(`backend обслуживает другой проект: ${link}`));
  check('симлинк: идентичный набор вызовов backend', viaLink.calls.slice(0, 3), direct.calls.slice(0, 3));
}

{
  const sb = sandbox({ indexes: ['tokensave'] });
  const res = sb.run(sb.root);
  check('только один маркер: код 0', res.status, 0);
  checkOk('отсутствующий маркер виден, корни не обязаны совпадать', res.out.includes('.ragsave/rag.db не найден'));
  check('ragsave не вызывался', res.calls, ['tokensave status', 'tokensave status -j', 'tokensave servers']);
}

{
  const sb = sandbox();
  sb.setTsJson({ last_sync_at: sb.headCt + 100, last_updated: sb.headCt });
  const res = sb.run(sb.root);
  check('last_updated на границе HEAD: код 0', res.status, 0);
  checkOk('граница объяснена без отставания и цикла sync', res.out.includes('last_updated совпадает с HEAD') && res.out.includes('stale_commits=1') && !res.out.includes('отставание по содержимому'));
  check('диагностика на границе не запускает sync', res.calls.filter((c) => c === 'tokensave sync').length, 0);
}

{
  const sb = sandbox();
  const sub = path.join(sb.root, 'packages', 'app');
  fs.mkdirSync(sub, { recursive: true });
  fs.writeFileSync(path.join(sub, 'settings.jsonc'), '{}\n');
  check('git add файла подкаталога', spawnSync('git', ['-C', sb.root, 'add', 'packages/app/settings.jsonc']).status, 0);
  index(sub, 'tokensave');
  await seedTokenSave(sub, ['settings.jsonc']);
  fs.writeFileSync(sb.tsStatus, `│ Project: ${sub} │\n│ Branch: [single-db] │\n`);
  const res = sb.run(sub);
  check('индекс в подкаталоге монорепо: код 0', res.status, 0);
  checkOk('покрытие подкаталога найдено', res.out.includes('покрытие: .jsonc'));
}

{
  const sb = sandbox();
  const sub = path.join(sb.root, 'packages', 'app');
  fs.mkdirSync(sub, { recursive: true });
  fs.writeFileSync(path.join(sub, 'settings.jsonc'), '{}\n');
  check('git add файла подкаталога', spawnSync('git', ['-C', sb.root, 'add', 'packages/app/settings.jsonc']).status, 0);
  index(sub, 'tokensave');
  await seedTokenSave(sub, ['other.jsonc']);
  fs.writeFileSync(sb.tsStatus, `│ Project: ${sub} │\n│ Branch: [single-db] │\n`);
  const res = sb.run(sub);
  check('непокрытый .jsonc подкаталога: код 0', res.status, 0);
  checkOk('пропуск покрытия виден с путём worktree', res.out.includes('нет покрытия: 1') && res.out.includes('packages/app/settings.jsonc'));
}

{
  const sb = sandbox();
  fs.writeFileSync(path.join(sb.root, 'settings.jsonc'), '{}\n');
  check('git add .jsonc рабочей ветки', spawnSync('git', ['-C', sb.root, 'add', 'settings.jsonc']).status, 0);
  check('git branch другой ветки', spawnSync('git', ['-C', sb.root, 'checkout', '-q', '-b', 'work']).status, 0);
  await seedTokenSave(sb.root, ['settings.jsonc'], path.join('branches', 'work.db'));
  fs.writeFileSync(path.join(sb.root, '.tokensave', 'branch-meta.json'), `${JSON.stringify({
    default_branch: 'main',
    branches: { main: { db_file: 'tokensave.db' }, work: { db_file: 'branches/work.db' } }
  })}\n`);
  fs.writeFileSync(sb.tsStatus, `│ Project: ${sb.root} │\n│ Branch: [work] │\n`);
  const res = sb.run(sb.root);
  check('покрытие активной ветки: код 0', res.status, 0);
  checkOk('покрытие читается из БД ветки, а не из default-ветки', res.out.includes('покрытие: .jsonc') && !res.out.includes('нет покрытия'));
}

process.exitCode = failed ? 1 : 0;
