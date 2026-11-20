#!/usr/bin/env node
// Тесты bin/mcp-serve.sh — запуска MCP tokensave/ragsave в явно выбранном проекте.
// Бинари подменяет fixtures/fake-indexer.mjs через AI_HOOKS_TOKENSAVE_CMD /
// AI_HOOKS_RAGSAVE_CMD либо симлинком $HOME/.local/bin/ragsave; HOME — песочница.
// Скрипт делает exec, поэтому код выхода и stdout — уже фейка, а корень, в
// котором поднят сервер, фейк пишет в FAKE_INDEXER_CWD.

import './env-isolate.mjs';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const FAKE = path.join(ROOT, 'test', 'fixtures', 'fake-indexer.mjs');
const SCRIPT = path.join(ROOT, 'bin', 'mcp-serve.sh');
const INDEX = { tokensave: ['.tokensave', 'tokensave.db'], ragsave: ['.ragsave', 'rag.db'] };

let failed = 0;
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  process.stdout.write(`${ok ? 'ok  ' : 'FAIL'} ${name} (got=${JSON.stringify(got)}, want=${JSON.stringify(want)})\n`);
  if (!ok) failed++;
}

const read = (file) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '');
const lines = (file) => read(file).split('\n').filter(Boolean);

function index(dir, kind) {
  const [sub, db] = INDEX[kind];
  fs.mkdirSync(path.join(dir, sub), { recursive: true });
  fs.writeFileSync(path.join(dir, sub, db), '');
}

function sandbox({ indexes = ['tokensave', 'ragsave'] } = {}) {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-serve-')));
  const root = path.join(home, 'proj');
  fs.mkdirSync(path.join(root, 'src', 'deep'), { recursive: true });
  for (const kind of indexes) index(root, kind);

  const calls = path.join(home, 'calls.jsonl');
  const cwds = path.join(home, 'cwd.txt');
  const env = {
    ...process.env, HOME: home, AI_HOOKS_TOKENSAVE_CMD: FAKE, AI_HOOKS_RAGSAVE_CMD: FAKE,
    FAKE_INDEXER_CALLS: calls, FAKE_INDEXER_CWD: cwds,
  };

  const run = (args, extra = {}, cwd = root) => {
    const e = { ...env, ...extra };
    for (const k of Object.keys(e)) if (e[k] === undefined) delete e[k];
    const res = spawnSync('bash', [SCRIPT, ...args], { cwd, encoding: 'utf8', env: e });
    return { status: res.status, stdout: res.stdout, stderr: res.stderr, calls: lines(calls).map((l) => JSON.parse(l)), cwds: lines(cwds) };
  };
  return { home, root, run };
}

// === tokensave ===

{
  const sb = sandbox();
  const res = sb.run(['tokensave']);
  check('tokensave: `serve -p <root>`', res.calls, [['serve', '-p', sb.root]]);
  check('tokensave: сервер поднят в корне проекта', res.cwds, [sb.root]);
  check('tokensave: stdout — сервера', res.stdout, `fake serve -p ${sb.root}\n`);
  check('tokensave: код 0', res.status, 0);
}

{
  const sb = sandbox();
  const res = sb.run(['tokensave'], { FAKE_INDEXER_EXIT: '5' });
  check('tokensave: код выхода — сервера', res.status, 5);
}

{
  const sb = sandbox();
  const res = sb.run(['tokensave'], {}, path.join(sb.root, 'src', 'deep'));
  check('tokensave: из подкаталога — ближайший индекс выше', [res.calls, res.cwds], [[['serve', '-p', sb.root]], [sb.root]]);
}

{
  const sb = sandbox();
  const inner = path.join(sb.root, 'src');
  index(inner, 'tokensave');
  const res = sb.run(['tokensave'], {}, path.join(inner, 'deep'));
  check('tokensave: вложенный проект — берётся ближайший', res.calls, [['serve', '-p', inner]]);
}

{
  const sb = sandbox();
  const res = sb.run(['tokensave'], {}, path.join(sb.root, 'src'));
  check('tokensave: каталог сессии — PWD', res.calls, [['serve', '-p', sb.root]]);
}

{
  const sb = sandbox();
  const bin = path.join(sb.home, 'bin');
  fs.mkdirSync(bin);
  fs.symlinkSync(FAKE, path.join(bin, 'tokensave'));
  const res = sb.run(['tokensave'], { AI_HOOKS_TOKENSAVE_CMD: undefined, PATH: `${bin}:${process.env.PATH}` });
  check('tokensave: без AI_HOOKS_TOKENSAVE_CMD — бинарь из PATH', res.calls, [['serve', '-p', sb.root]]);
}

{
  const sb = sandbox({ indexes: ['ragsave'] });
  const res = sb.run(['tokensave']);
  check('tokensave: индекса нет — код 1, без запуска', [res.status, res.calls], [1, []]);
  check('tokensave: индекса нет — подсказка про tokensave init',
    res.stderr.includes(`tokensave: индекса нет ни в ${sb.root}`) && res.stderr.includes('tokensave init <path>'), true);
}

{
  const sb = sandbox({ indexes: [] });
  index(sb.home, 'tokensave');
  const res = sb.run(['tokensave'], {}, path.join(sb.root, 'src'));
  check('tokensave: индекс только в $HOME — проектом не считается', [res.status, res.calls], [1, []]);
  check('tokensave: старт в самом $HOME — не запускается', [sb.run(['tokensave'], {}, sb.home).calls], [[]]);
}

// === ragsave ===

{
  const sb = sandbox();
  const res = sb.run(['ragsave']);
  check('ragsave: `serve` без аргументов', res.calls, [['serve']]);
  check('ragsave: сервер поднят в корне проекта', res.cwds, [sb.root]);
  check('ragsave: код 0', res.status, 0);
}

{
  const sb = sandbox();
  const res = sb.run(['ragsave'], {}, path.join(sb.root, 'src', 'deep'));
  check('ragsave: из подкаталога — корень проекта', res.cwds, [sb.root]);
}

{
  const sb = sandbox();
  const local = path.join(sb.home, '.local', 'bin');
  fs.mkdirSync(local, { recursive: true });
  fs.symlinkSync(FAKE, path.join(local, 'ragsave'));
  const res = sb.run(['ragsave'], { AI_HOOKS_RAGSAVE_CMD: undefined });
  check('ragsave: без AI_HOOKS_RAGSAVE_CMD — $HOME/.local/bin/ragsave', res.calls, [['serve']]);
}

{
  const sb = sandbox({ indexes: ['tokensave'] });
  const res = sb.run(['ragsave']);
  check('ragsave: нет rag.db — код 1, без запуска', [res.status, res.calls], [1, []]);
  check('ragsave: нет rag.db — подсказка про ragsave init', res.stderr.includes('ragsave init <path>'), true);
}

// === выбор дерева: git-границы, симлинки, worktree ===

const gitInit = (dir) => {
  fs.mkdirSync(dir, { recursive: true });
  spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
};
const gitCommit = (dir) => spawnSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'x'], { cwd: dir });

{
  const sb = sandbox();
  const inner = path.join(sb.root, 'src');
  spawnSync('git', ['init', '-q'], { cwd: inner });
  const res = sb.run(['tokensave'], {}, path.join(inner, 'deep'));
  check('tokensave: вложенный Git без индекса — отказ, не родитель', [res.status, res.calls], [1, []]);
}

{
  const sb = sandbox();
  const deep = path.join(sb.root, 'src', 'deep');
  const alias = path.join(sb.home, 'alias');
  fs.symlinkSync(deep, alias);
  const direct = sb.run(['tokensave'], {}, deep);
  const via = sb.run(['tokensave'], { PWD: alias }, alias);
  check('tokensave: симлинк и прямой путь — одинаковое дерево',
    [via.status, via.calls.slice(direct.calls.length), via.cwds.slice(direct.cwds.length)],
    [direct.status, direct.calls, direct.cwds]);
}

{
  const sb = sandbox({ indexes: [] });
  const main = path.join(sb.home, 'main');
  const linked = path.join(sb.home, 'linked');
  gitInit(main);
  gitCommit(main);
  spawnSync('git', ['worktree', 'add', '-q', linked], { cwd: main });
  index(main, 'tokensave');
  fs.mkdirSync(path.join(linked, 'src'));
  const noOwn = sb.run(['tokensave'], {}, path.join(linked, 'src'));
  check('tokensave: linked worktree без своего индекса — отказ, не основное дерево', [noOwn.status, noOwn.calls], [1, []]);
  index(linked, 'tokensave');
  const own = sb.run(['tokensave'], {}, path.join(linked, 'src'));
  check('tokensave: linked worktree со своим индексом — обслуживается', [own.calls, own.cwds], [[['serve', '-p', linked]], [linked]]);
}

{
  const sb = sandbox({ indexes: [] });
  const det = path.join(sb.home, 'detached');
  gitInit(det);
  gitCommit(det);
  spawnSync('git', ['checkout', '-q', '--detach'], { cwd: det });
  index(det, 'tokensave');
  const res = sb.run(['tokensave'], {}, det);
  check('tokensave: detached HEAD — обслуживается целевое дерево', res.calls, [['serve', '-p', det]]);
}

{
  const sb = sandbox({ indexes: [] });
  const mono = path.join(sb.home, 'mono');
  gitInit(mono);
  const ts = path.join(mono, 'svc-ts');
  const rg = path.join(mono, 'svc-rg');
  index(ts, 'tokensave');
  index(rg, 'ragsave');
  const tsRes = sb.run(['tokensave'], {}, ts);
  check('tokensave: монорепо только со своим индексом — находится', tsRes.calls, [['serve', '-p', ts]]);
  const rgRes = sb.run(['ragsave'], {}, rg);
  check('ragsave: монорепо только со своим индексом — находится',
    [rgRes.calls.slice(tsRes.calls.length), rgRes.cwds.slice(tsRes.cwds.length)], [[['serve']], [rg]]);
}

{
  const sb = sandbox({ indexes: [] });
  const a = path.join(sb.home, 'a');
  const b = path.join(sb.home, 'b');
  for (const [dir, text] of [[a, 'контроль-a'], [b, 'контроль-b']]) {
    fs.mkdirSync(dir);
    index(dir, 'tokensave');
    fs.writeFileSync(path.join(dir, 'SENTINEL.txt'), text);
  }
  const resA = sb.run(['tokensave'], { FAKE_INDEXER_SENTINEL: 'SENTINEL.txt' }, a);
  const resB = sb.run(['tokensave'], { FAKE_INDEXER_SENTINEL: 'SENTINEL.txt' }, b);
  check('tokensave: контрольная строка обслуживаемого дерева — a', resA.stdout, `fake serve -p ${a}\nконтроль-a\n`);
  check('tokensave: контрольная строка обслуживаемого дерева — b', resB.stdout, `fake serve -p ${b}\nконтроль-b\n`);
}

{
  const sb = sandbox();
  const inner = path.join(sb.root, 'src');
  spawnSync('git', ['init', '-q'], { cwd: inner });
  const res = sb.run(['ragsave'], {}, path.join(inner, 'deep'));
  check('ragsave: вложенный Git без индекса — отказ, не родитель', [res.status, res.calls], [1, []]);
}

// === аргументы ===

{
  const sb = sandbox();
  const res = sb.run(['nosuch']);
  check('неизвестный сервер — код 2, без запуска', [res.status, res.calls], [2, []]);
  check('неизвестный сервер — сообщение', res.stderr.includes('неизвестный сервер: nosuch'), true);
}

{
  const sb = sandbox();
  const res = sb.run([]);
  check('без аргумента — код 1 и usage', [res.status, res.calls, res.stderr.includes('usage: mcp-serve.sh')], [1, [], true]);
}

process.stdout.write(failed ? `\n=== ${failed} проверок упало ===\n` : '\n=== все проверки прошли ===\n');
process.exit(failed ? 1 : 0);
