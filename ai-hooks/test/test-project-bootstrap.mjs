#!/usr/bin/env node
// Тест SessionStart-хука project-bootstrap: пустой node-репозиторий с GitHub
// remote даёт полный список пропусков, вне репозитория хук молчит,
// а недельная метка не мешает первому напоминанию (каталог метки временный).
// При одном индексе хук зовёт project-init.sh --detach — вместо него фейк.

import './env-isolate.mjs';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SCRIPT = path.join(ROOT, 'claude', 'project-bootstrap.mjs');
const FAKE_INIT = path.join(ROOT, 'test', 'fixtures', 'fake-indexer.mjs');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bootstrap-test-'));
const repo = path.join(tmp, 'repo');
fs.mkdirSync(repo);
execFileSync('git', ['-C', repo, 'init', '-q']);
execFileSync('git', ['-C', repo, 'remote', 'add', 'origin', 'https://github.com/x/y.git']);
fs.writeFileSync(path.join(repo, 'package.json'), '{}');
fs.writeFileSync(path.join(repo, '.env'), 'A=1\n');

function run(cwd, env = {}) {
  const out = execFileSync('node', [SCRIPT], {
    input: JSON.stringify({ session_id: 't', cwd, hook_event_name: 'SessionStart', source: 'startup' }),
    encoding: 'utf8',
    env: { ...process.env, HOME: tmp, AI_HOOKS_STATE_DIR: '', ...env },  // недельная метка — под HOME песочницы
  });
  return out.trim() ? JSON.parse(out).hookSpecificOutput.additionalContext : null;
}

let failed = 0;
const check = (name, ok, detail = '') => {
  process.stdout.write(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}\n`);
  if (!ok) failed++;
};

// Метки лежат под HOME теста; «прошло 8 дней» — сдвиг mtime всех меток назад.
const STATE = path.join(tmp, '.claude', 'state', 'bootstrap');
const eightDaysLater = () => {
  const past = new Date(Date.now() - 8 * 24 * 3600 * 1000);
  for (const f of fs.readdirSync(STATE)) fs.utimesSync(path.join(STATE, f), past, past);
};

const first = run(repo) || '';
check('без индекса: про CLAUDE.md молчит', !/CLAUDE\.md/.test(first), first);
check('без индекса: про карту связей молчит', !/impact-map/.test(first));
check('.env без примера не упоминается', !/\.env/.test(first), first);
check('нет husky', /husky/.test(first));
check('нет CI для GitHub', /workflows/.test(first));
check('нет dependabot', /dependabot/.test(first));

const second = run(repo) || '';
check('повтор: husky/CI молчат неделю', !/husky|workflows/.test(second), second);

fs.writeFileSync(path.join(repo, 'CLAUDE.md'), '# x');
check('всё на месте: хук молчит', run(repo) === null);

check('вне репозитория: молчит', run(tmp) === null);

// Инициализация: индекс появился, CLAUDE.md нет — один раз на проект, дальше молчит.
const fresh = path.join(tmp, 'fresh');
fs.mkdirSync(path.join(fresh, '.tokensave'), { recursive: true });
execFileSync('git', ['-C', fresh, 'init', '-q']);
fs.writeFileSync(path.join(fresh, '.tokensave', 'tokensave.db'), '');
const freshFirst = run(fresh) || '';
check('первая сессия: CLAUDE.md и /impact-map одним пунктом',
  /just indexed: [^;]*CLAUDE\.md[^;]*\/impact-map/.test(freshFirst), freshFirst);
check('первая сессия: недельного пункта карты нет', freshFirst.split('impact-map').length === 2, freshFirst);
check('повтор: CLAUDE.md молчит насовсем', !/CLAUDE\.md/.test(run(fresh) || ''));
fs.rmSync(fresh, { recursive: true, force: true });

// Индекс есть, карты нет — /impact-map один раз на проект, без недельного повтора.
function mapRepo(name, db) {
  const dir = path.join(tmp, name);
  fs.mkdirSync(path.join(dir, path.dirname(db)), { recursive: true });
  execFileSync('git', ['-C', dir, 'init', '-q']);
  fs.writeFileSync(path.join(dir, 'CLAUDE.md'), '# x');
  fs.writeFileSync(path.join(dir, db), '');
  return dir;
}
for (const db of ['.ragsave/rag.db', '.tokensave/tokensave.db']) {
  const dir = mapRepo(`map-${path.basename(db)}`, db);
  check(`${db} без карты: первая сессия предлагает /impact-map`, /impact-map/.test(run(dir) || ''));
  check(`${db}: повтор молчит`, run(dir) === null);
  eightDaysLater();
  check(`${db}: и через 8 дней карта не возвращается`, run(dir) === null);
}

const mapped = mapRepo('mapped', '.ragsave/rag.db');
fs.mkdirSync(path.join(mapped, 'docs', 'links'), { recursive: true });
fs.writeFileSync(path.join(mapped, 'docs', 'links', 'INDEX.md'), '# x');
check('карта есть: молчит', run(mapped) === null);

const ignoring = mapRepo('ignoring', '.tokensave/tokensave.db');
fs.mkdirSync(path.join(ignoring, '.claude'));
fs.writeFileSync(path.join(ignoring, '.claude', 'bootstrap-ignore'), 'impact-map\n');
check('bootstrap-ignore: про карту молчит', run(ignoring) === null);

// Достройка второго индекса. Фейк уходит в фон: сначала случаи без вызова,
// последним — с вызовом; в файле вызовов должна оказаться только его строка.
const calls = path.join(tmp, 'init-calls');
const fakeEnv = { AI_HOOKS_PROJECT_INIT_CMD: FAKE_INIT, FAKE_INDEXER_CALLS: calls };
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
function indexedRepo(name, dbs) {
  const dir = path.join(tmp, name);
  fs.mkdirSync(dir);
  execFileSync('git', ['-C', dir, 'init', '-q']);
  for (const db of dbs) {
    fs.mkdirSync(path.join(dir, path.dirname(db)), { recursive: true });
    fs.writeFileSync(path.join(dir, db), '');
  }
  return execFileSync('git', ['-C', dir, 'rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
}
run(indexedRepo('none', []), fakeEnv);
run(indexedRepo('both', ['.tokensave/tokensave.db', '.ragsave/rag.db']), fakeEnv);
run(indexedRepo('disabled', ['.tokensave/tokensave.db', '.ragsave-disable']), fakeEnv);
const one = indexedRepo('one', ['.ragsave/rag.db']);
run(one, fakeEnv);
// Оба индекса, но init tokensave оборвался — need_ts скрипта это умеет.
const dirty = indexedRepo('dirty', ['.tokensave/tokensave.db', '.tokensave/dirty', '.ragsave/rag.db']);
run(dirty, fakeEnv);
const callLines = () => (fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8').trim().split('\n') : []);
for (let i = 0; i < 50 && callLines().length < 2; i++) sleep(100);
sleep(300);  // время на лишний вызов, если он был
const lines = callLines().sort();
check('один индекс или .tokensave/dirty: project-init --detach <корень>; оба, ни одного, .ragsave-disable — без вызова',
  JSON.stringify(lines) === JSON.stringify([['--detach', dirty], ['--detach', one]].map((c) => JSON.stringify(c)).sort()), lines.join(' | '));

fs.rmSync(tmp, { recursive: true, force: true });
process.stdout.write(failed ? `\n${failed} FAIL\n` : '\nвсе проверки прошли\n');
process.exit(failed ? 1 : 0);
