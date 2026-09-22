#!/usr/bin/env node
// Тесты `install.sh --check` — отчёта о симлинках харнеса без правок.
// install.sh находит харнесс по своему пути, поэтому в песочнице собран
// мини-харнесс: симлинк на настоящий install.sh, пустые источники из LINKS и
// fixtures/fake-indexer.mjs на месте bin/mcp-sync.mjs. HOME — та же песочница,
// PATH — только нужные скрипту утилиты: настоящие claude, tokensave, opencode и
// python3 не запускаются, а где они нужны, их заменяет тот же фейк.

import './env-isolate.mjs';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const INSTALL = path.join(path.dirname(ROOT), 'install.sh');
const FAKE = path.join(ROOT, 'test', 'fixtures', 'fake-indexer.mjs');
const LINKS = [...fs.readFileSync(INSTALL, 'utf8').matchAll(/^\s*"\$HOME\/([^|"]+)\|([^"]+)"$/gm)]
  .map(([, target, src]) => ({ target, src }));
// mkdir/mv/ln/rm --check не нужны; они в PATH, чтобы правку, если она случится, поймал снимок.
const TOOLS = ['date', 'dirname', 'basename', 'readlink', 'grep', 'head', 'sed', 'awk', 'node', 'mkdir', 'mv', 'ln', 'rm'];
const BASH = spawnSync('bash', ['-c', 'command -v bash'], { encoding: 'utf8' }).stdout.trim();

let failed = 0;
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  process.stdout.write(`${ok ? 'ok  ' : 'FAIL'} ${name} (got=${JSON.stringify(got)}, want=${JSON.stringify(want)})\n`);
  if (!ok) failed++;
}

const read = (file) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '');
// eslint-disable-next-line no-control-regex
const plain = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');

// Всё под HOME, кроме мини-харнесса и служебных файлов теста: тип и цель симлинка.
function snapshot(home, skip) {
  const out = [];
  const walk = (dir) => {
    for (const name of fs.readdirSync(dir).sort()) {
      const p = path.join(dir, name);
      if (skip.includes(p)) continue;
      const st = fs.lstatSync(p);
      if (st.isSymbolicLink()) out.push(`${p} -> ${fs.readlinkSync(p)}`);
      else if (st.isDirectory()) walk(p);
      else out.push(`${p} [${read(p)}]`);
    }
  };
  walk(home);
  return out;
}
const changes = (before, after) => [
  ...before.filter((x) => !after.includes(x)).map((x) => `- ${x}`),
  ...after.filter((x) => !before.includes(x)).map((x) => `+ ${x}`),
];

function sandbox({ settings = '{}', tools = TOOLS, fakes = [] } = {}) {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'install-check-')));
  const harness = path.join(home, 'harness');
  for (const { src } of LINKS) {
    fs.mkdirSync(path.dirname(path.join(harness, src)), { recursive: true });
    fs.writeFileSync(path.join(harness, src), '');
  }
  fs.writeFileSync(path.join(harness, 'claude', 'settings.json'), settings);
  fs.mkdirSync(path.join(harness, 'bin'), { recursive: true });
  fs.symlinkSync(FAKE, path.join(harness, 'bin', 'mcp-sync.mjs'));
  fs.symlinkSync(INSTALL, path.join(harness, 'install.sh'));

  const bin = path.join(home, 'path');
  fs.mkdirSync(bin);
  for (const t of tools) {
    fs.symlinkSync(spawnSync(BASH, ['-c', `command -v ${t}`], { encoding: 'utf8' }).stdout.trim(), path.join(bin, t));
  }
  for (const f of fakes) fs.symlinkSync(FAKE, path.join(bin, f));

  // Все цели — верные симлинки; сценарий портит нужные.
  const target = (t) => path.join(home, t);
  for (const { target: t, src } of LINKS) {
    fs.mkdirSync(path.dirname(target(t)), { recursive: true });
    fs.symlinkSync(path.join(harness, src), target(t));
  }

  const calls = path.join(home, 'calls.jsonl');
  const skip = [harness, bin, calls];
  const run = (args = ['--check'], extra = {}) => {
    const env = { HOME: home, PATH: bin, FAKE_INDEXER_CALLS: calls, ...extra };
    const res = spawnSync(BASH, [path.join(harness, 'install.sh'), ...args], { cwd: home, encoding: 'utf8', env });
    return { status: res.status, out: plain(res.stdout), calls: read(calls).split('\n').filter(Boolean).map((l) => JSON.parse(l)) };
  };
  return { home, harness, target, run, snap: () => snapshot(home, skip) };
}

const summary = (ok, drift, missing) => `на месте: ${ok}, требуют внимания: ${drift}, нет источника: ${missing}`;

check('LINKS разобран из install.sh', LINKS.length > 20 && LINKS.some((l) => l.target === '.ai-hooks' && l.src === 'ai-hooks'), true);

{
  const sb = sandbox();
  const res = sb.run();
  check('всё на месте — код 0', res.status, 0);
  check('всё на месте — итог', res.out.includes(summary(LINKS.length, 0, 0)), true);
  check('mcp-sync зовётся с --check', res.calls, [['--check']]);
  check('settings.json без зашитого /home — проверка домашнего каталога пропущена', res.out.includes('домашний каталог'), false);
}

{
  const sb = sandbox();
  const [wrong, file, gone] = ['.claude/CLAUDE.md', '.bashrc', '.gitconfig'].map(sb.target);
  // Мимо репозитория, но в существующий файл — как симлинк в старый клон.
  const elsewhere = path.join(sb.home, 'old-clone', 'CLAUDE.md');
  fs.mkdirSync(path.dirname(elsewhere));
  fs.writeFileSync(elsewhere, '');
  fs.rmSync(wrong);
  fs.symlinkSync(elsewhere, wrong);
  fs.rmSync(file);
  fs.writeFileSync(file, 'свой bashrc');
  fs.rmSync(gone);
  fs.rmSync(path.join(sb.harness, 'rules', 'core.md'));
  const before = sb.snap();
  const res = sb.run();
  // rules/core.md — источник двух целей (Claude и OpenCode).
  check('расхождения — код 1', res.status, 1);
  check('расхождения — итог', res.out.includes(summary(LINKS.length - 5, 3, 2)), true);
  check('симлинк мимо репозитория назван', res.out.includes(`${wrong} — симлинк ведёт мимо репозитория: ${elsewhere}`), true);
  check('обычный файл назван', res.out.includes(`${file} — обычный файл, а не симлинк`), true);
  check('нет цели — названа', res.out.includes(`${gone} — нет`), true);
  check('нет источника — назван', res.out.includes('— нет источника rules/core.md в репозитории'), true);
  check('--check ничего не меняет: ни симлинков, ни бэкапов', changes(before, sb.snap()), []);
}

{
  const sb = sandbox();
  fs.rmSync(path.join(sb.harness, 'git', 'gitconfig'));
  const res = sb.run();
  check('нет только источника — код 1', [res.status, res.out.includes(summary(LINKS.length - 1, 0, 1))], [1, true]);
}

{
  const sb = sandbox();
  const res = sb.run(['--check'], { FAKE_INDEXER_EXIT: '1' });
  check('mcp-sync --check расходится — код 1 и +1 к вниманию', [res.status, res.out.includes(summary(LINKS.length, 1, 0))], [1, true]);
}

{
  const sb = sandbox({ tools: TOOLS.filter((t) => t !== 'node') });
  const res = sb.run();
  check('node нет — MCP не сверен, +1 к вниманию', [res.status, res.out.includes('node не найден — MCP не сверить'), res.out.includes(summary(LINKS.length, 1, 0))], [1, true, true]);
}

{
  const sb = sandbox({ settings: '{"hooks":"/home/someone/.ai-hooks/claude/x.mjs"}' });
  const res = sb.run();
  check('зашитый домашний каталог не совпадает — код 1', res.status, 1);
  check('зашитый домашний каталог не совпадает — названы оба', res.out.includes(`в конфигах /home/someone, здесь ${sb.home}`), true);
  check('зашитый домашний каталог не совпадает — +1 к вниманию', res.out.includes(summary(LINKS.length, 1, 0)), true);
}

{
  const sb = sandbox();
  const res = sb.run();
  check('внешних бинарей нет — названы, код не меняют',
    [res.status, res.out.includes('claude — не найден'), res.out.includes('tokensave — не найден'), res.out.includes('python3 — не найден')],
    [0, true, true, true]);
}

{
  const sb = sandbox({ fakes: ['claude', 'tokensave'] });
  const res = sb.run();
  check('claude и tokensave в PATH — найдены', [res.out.includes('claude fake --version'), res.out.includes(`tokensave: ${path.join(sb.home, 'path', 'tokensave')}`)], [true, true]);
}

{
  const sb = sandbox();
  const before = sb.snap();
  const res = sb.run(['--bogus']);
  check('неизвестный режим — код 2 и usage', [res.status, res.out.includes('Использование: ./install.sh [--check|--venv]')], [2, true]);
  check('неизвестный режим — ничего не меняет', changes(before, sb.snap()), []);
}

process.stdout.write(failed ? `\n=== ${failed} проверок упало ===\n` : '\n=== все проверки прошли ===\n');
process.exit(failed ? 1 : 0);
