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
    FAKE_INDEXER_CALLS: calls, FAKE_INDEXER_CWD: cwds, CLAUDE_PROJECT_DIR: root,
  };

  // cwd по умолчанию — HOME: так запасной PWD никогда не попадает в проект случайно.
  const run = (args, extra = {}, cwd = home) => {
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
  const res = sb.run(['tokensave'], { CLAUDE_PROJECT_DIR: path.join(sb.root, 'src', 'deep') });
  check('tokensave: из подкаталога — ближайший индекс выше', [res.calls, res.cwds], [[['serve', '-p', sb.root]], [sb.root]]);
}

{
  const sb = sandbox();
  const inner = path.join(sb.root, 'src');
  index(inner, 'tokensave');
  const res = sb.run(['tokensave'], { CLAUDE_PROJECT_DIR: path.join(inner, 'deep') });
  check('tokensave: вложенный проект — берётся ближайший', res.calls, [['serve', '-p', inner]]);
}

{
  const sb = sandbox();
  const res = sb.run(['tokensave'], { CLAUDE_PROJECT_DIR: undefined }, path.join(sb.root, 'src'));
  check('tokensave: без CLAUDE_PROJECT_DIR — от PWD', res.calls, [['serve', '-p', sb.root]]);
}

{
  const sb = sandbox();
  const tools = (extra) => sb.run(['tokensave'], { TOKENSAVE_TOOLS: undefined, ...extra }).stderr;
  check('tokensave: под Claude Code — полный список', tools({ CLAUDECODE: '1' }), 'TOKENSAVE_TOOLS=full\n');
  check('tokensave: заданный TOKENSAVE_TOOLS не перебивается', tools({ CLAUDECODE: '1', TOKENSAVE_TOOLS: 'core' }), 'TOKENSAVE_TOOLS=core\n');
  check('tokensave: вне Claude Code (OpenCode) — список сервера', tools({ CLAUDECODE: undefined }), '');
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
  const res = sb.run(['tokensave'], { CLAUDE_PROJECT_DIR: path.join(sb.root, 'src') });
  check('tokensave: индекс только в $HOME — проектом не считается', [res.status, res.calls], [1, []]);
  check('tokensave: старт в самом $HOME — не запускается', [sb.run(['tokensave'], { CLAUDE_PROJECT_DIR: sb.home }).calls], [[]]);
}

{
  const sb = sandbox();
  const res = sb.run(['tokensave'], { CLAUDE_PROJECT_DIR: path.join(sb.home, 'nonexistent') });
  check('tokensave: каталога сессии нет — код 1, без запуска', [res.status, res.calls], [1, []]);
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
  const res = sb.run(['ragsave'], { CLAUDE_PROJECT_DIR: path.join(sb.root, 'src', 'deep') });
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

// === аргументы ===

{
  const sb = sandbox();
  const res = sb.run(['opencode']);
  check('неизвестный сервер — код 2, без запуска', [res.status, res.calls], [2, []]);
  check('неизвестный сервер — сообщение', res.stderr.includes('неизвестный сервер: opencode'), true);
}

{
  const sb = sandbox();
  const res = sb.run([]);
  check('без аргумента — код 1 и usage', [res.status, res.calls, res.stderr.includes('usage: mcp-serve.sh')], [1, [], true]);
}

process.stdout.write(failed ? `\n=== ${failed} проверок упало ===\n` : '\n=== все проверки прошли ===\n');
process.exit(failed ? 1 : 0);
