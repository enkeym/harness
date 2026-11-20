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

function sandbox({ indexes = ['tokensave', 'ragsave'] } = {}) {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'project-identity-')));
  const root = path.join(home, 'proj');
  fs.mkdirSync(root, { recursive: true });
  check('git init', spawnSync('git', ['init', '-q', root]).status, 0);
  for (const kind of indexes) index(root, kind);

  const bin = path.join(home, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  const ts = path.join(bin, 'tokensave');
  const rg = path.join(bin, 'ragsave');
  fs.writeFileSync(ts, [
    '#!/usr/bin/env bash',
    'echo "tokensave $1" >> "$FAKE_CALLS"',
    'if [ "$1" = status ]; then cat "$FAKE_TS_STATUS"; else echo "No tokensave servers running."; fi'
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
  const rgStatus = path.join(home, 'rg-status.json');
  fs.writeFileSync(tsStatus, `│ Project: ${root} │\n│ Branch: [single-db] │\n`);
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
    FAKE_RG_STATUS: rgStatus,
    PLAYWRIGHT_MCP_EXTENSION_TOKEN: 'test-token'
  };
  const run = (dir) => {
    const res = spawnSync(process.execPath, [SCRIPT, dir], { encoding: 'utf8', env, timeout: 30000 });
    return { status: res.status, out: res.stdout + res.stderr, calls: lines(calls) };
  };
  return { home, root, run, tsStatus };
}

{
  const sb = sandbox();
  const res = sb.run(sb.root);
  check('согласованная идентичность: код 0', res.status, 0);
  checkOk('показан ожидаемый реальный путь', res.out.includes(sb.root));
  checkOk('показан Git worktree и ветка', res.out.includes('Git worktree') && /ветка: \S+/.test(res.out));
  checkOk('показаны оба маркера', res.out.includes('.tokensave/tokensave.db') && res.out.includes('.ragsave/rag.db'));
  checkOk('показан фактический путь backend', res.out.includes('фактический реальный путь backend'));
  checkOk('Playwright проверен отдельно', res.out.includes('Playwright') && res.out.includes('PLAYWRIGHT_MCP_EXTENSION_TOKEN задан'));
  check('backend вызван только для статуса', res.calls, ['tokensave status', 'tokensave servers', 'ragsave status']);
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
  check('ragsave не вызывался', res.calls, ['tokensave status', 'tokensave servers']);
}

process.exitCode = failed ? 1 : 0;
