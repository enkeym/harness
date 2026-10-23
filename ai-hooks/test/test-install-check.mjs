#!/usr/bin/env node
// Тесты `install.sh --check` — отчёта о симлинках харнеса без правок.
// install.sh находит харнесс по своему пути, поэтому в песочнице собран
// мини-харнесс: симлинк на настоящий install.sh, пустые источники из LINKS и
// fixtures/fake-indexer.mjs на месте bin/mcp-sync.mjs. HOME — та же песочница,
// PATH — только нужные скрипту утилиты: настоящие claude, tokensave и
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
// Пары target|source из массива install.sh; $RAG_HOME без RAGSAVE_HOME — ~/.rag-mcp.
const pairs = (name) => {
  const block = fs.readFileSync(INSTALL, 'utf8').match(new RegExp(`^${name}=\\(\\n([\\s\\S]*?)^\\)`, 'm'))[1];
  return [...block.matchAll(/^\s*"\$(HOME|RAG_HOME)\/([^|"]+)\|([^"]+)"$/gm)]
    .map(([, base, target, src]) => ({ target: base === 'RAG_HOME' ? `.rag-mcp/${target}` : target, src }));
};
const LINKS = pairs('LINKS');
const LOCALS = pairs('LOCALS');
const ALL = LINKS.length + LOCALS.length;
// mkdir/mv/ln/rm/cp --check не нужны; они в PATH, чтобы правку, если она случится, поймал снимок.
const TOOLS = ['date', 'dirname', 'basename', 'readlink', 'grep', 'head', 'sed', 'awk', 'node', 'mkdir', 'mv', 'ln', 'rm', 'cp'];
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
  for (const { src } of LOCALS) {
    fs.mkdirSync(path.dirname(path.join(harness, src)), { recursive: true });
    fs.writeFileSync(path.join(harness, src), `шаблон ${src}`);
  }
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
  // Локальные файлы — уже заполненные копии.
  for (const { target: t } of LOCALS) {
    fs.mkdirSync(path.dirname(target(t)), { recursive: true });
    fs.writeFileSync(target(t), 'свои значения');
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

check('LINKS разобран из install.sh', LINKS.length > 10 && LINKS.some((l) => l.target === '.ai-hooks' && l.src === 'ai-hooks'), true);
check('LINKS: $RAG_HOME — ~/.rag-mcp', LINKS.some((l) => l.target === '.rag-mcp/ragsave' && l.src === 'ragsave/ragsave'), true);
check('LOCALS разобран и не смешан с LINKS',
  [LOCALS.map((l) => l.target), LINKS.some((l) => l.src.startsWith('local/'))],
  [['.config/harness/env', '.gitconfig.local'], false]);

{
  const sb = sandbox();
  const res = sb.run();
  check('всё на месте — код 0', res.status, 0);
  check('всё на месте — итог', res.out.includes(summary(ALL, 0, 0)), true);
  check('mcp-sync зовётся с --check', res.calls, [['--check']]);
  check('чистые источники — ✓ без зашитых домашних каталогов', res.out.includes('✓ в источниках симлинков нет зашитых'), true);
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
  check('расхождения — код 1', res.status, 1);
  check('расхождения — итог', res.out.includes(summary(ALL - 4, 3, 1)), true);
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
  check('нет только источника — код 1', [res.status, res.out.includes(summary(ALL - 1, 0, 1))], [1, true]);
}

{
  const sb = sandbox();
  const res = sb.run(['--check'], { FAKE_INDEXER_EXIT: '1' });
  check('mcp-sync --check расходится — код 1 и +1 к вниманию', [res.status, res.out.includes(summary(ALL, 1, 0))], [1, true]);
}

{
  const sb = sandbox({ tools: TOOLS.filter((t) => t !== 'node') });
  const res = sb.run();
  check('node нет — MCP не сверен, +1 к вниманию', [res.status, res.out.includes('node не найден — MCP не сверить'), res.out.includes(summary(ALL, 1, 0))], [1, true, true]);
}

{
  const sb = sandbox({ settings: '{\n"hooks": "node /home/someone/.ai-hooks/claude/x.mjs"\n}' });
  fs.writeFileSync(path.join(sb.harness, 'rules', 'core.md'), 'allowed-tools: Bash(node /Users/someone/.ai-hooks/bin/x.mjs)\n');
  // Тесты и логи не в счёт: фикстуры нарочно подставляют чужой HOME.
  fs.rmSync(path.join(sb.harness, 'ai-hooks'));
  for (const dir of ['test', 'logs']) {
    fs.mkdirSync(path.join(sb.harness, 'ai-hooks', dir), { recursive: true });
    fs.writeFileSync(path.join(sb.harness, 'ai-hooks', dir, 'x.mjs'), "const HOME = '/home/someone/';\n");
  }
  const res = sb.run();
  check('зашитый домашний каталог — код 1 и ✗', [res.status, res.out.includes('✗ в источниках симлинков зашит домашний каталог')], [1, true]);
  check('зашитый домашний каталог — /home и /Users названы файл:строка',
    [res.out.includes('claude/settings.json:2\n'), res.out.includes('rules/core.md:1\n')], [true, true]);
  check('зашитый домашний каталог — test/ и logs/ пропущены', res.out.includes('x.mjs'), false);
  check('зашитый домашний каталог — +1 к вниманию', res.out.includes(summary(ALL, 1, 0)), true);
}

{
  const sb = sandbox();
  const env = sb.target('.config/harness/env');
  fs.rmSync(env);
  const before = sb.snap();
  const res = sb.run();
  check('нет локального env — предупреждение и код 1',
    [res.status, res.out.includes(`${env} — нет, ./install.sh создаст его из local/env.example`), res.out.includes(summary(ALL - 1, 1, 0))],
    [1, true, true]);
  check('нет локального env — --check его не создаёт', changes(before, sb.snap()), []);
}

{
  const sb = sandbox();
  const [env, gitLocal] = LOCALS.map(({ target }) => sb.target(target));
  fs.rmSync(env);
  fs.rmSync(path.dirname(env), { recursive: true });
  const res = sb.run([]);
  check('install создаёт локальный файл из шаблона и просит заполнить',
    [read(env), fs.lstatSync(env).isSymbolicLink(), res.out.includes(`${env} — создан из local/env.example, заполнить`)],
    ['шаблон local/env.example', false, true]);
  check('install не затирает существующий локальный файл', read(gitLocal), 'свои значения');
  fs.writeFileSync(env, 'заполнен');
  sb.run([]);
  check('повторный install не затирает заполненный файл', read(env), 'заполнен');
}

{
  const hooks = (bin) => `{"hooks": [{"type": "command", "command": "${bin}", "args": ["hook-stop"]}]}`;
  const other = sandbox({ settings: hooks('/usr/local/bin/tokensave'), fakes: ['tokensave'] });
  const res = other.run();
  const here = path.join(other.home, 'path', 'tokensave');
  check('хуки tokensave зовут другой путь — ✗, оба пути и код 1',
    [res.status, res.out.includes(`✗ хуки tokensave в claude/settings.json зовут /usr/local/bin/tokensave, а tokensave здесь: ${here}`)],
    [1, true]);
  const same = sandbox({ fakes: ['tokensave'] });
  const sameBin = path.join(same.home, 'path', 'tokensave');
  fs.writeFileSync(path.join(same.harness, 'claude', 'settings.json'), hooks(sameBin));
  check('хуки tokensave зовут найденный бинарь — ✓', same.run().out.includes(`✓ хуки tokensave в claude/settings.json зовут ${sameBin}`), true);
}

{
  const state = (agents) => `last_installed_version = "7.12.1"\ninstalled_agents = ${agents}\ncached_country_flags = ["ru"]\n`;
  const clean = sandbox();
  fs.writeFileSync(clean.target('.tokensave/state.toml'), state('[]'));
  const res = clean.run();
  check('state.toml без агентов, правил tokensave нет — следов install нет',
    [res.status, /след tokensave install|tokensave install записал/.test(res.out), res.out.includes(summary(ALL, 0, 0))], [0, false, true]);

  const sb = sandbox();
  fs.writeFileSync(sb.target('.tokensave/state.toml'), state('[\n    "claude",\n]'));
  const rules = sb.target('.claude/rules/tokensave.md');
  fs.writeFileSync(rules, '');
  const after = sb.run();
  check('следы tokensave install — ✗ на агента и файл правил, код 1',
    [after.status, after.out.includes('✗ tokensave install записал агентов: claude —'),
      after.out.includes(`✗ ${rules} — след tokensave install`), after.out.includes(summary(ALL, 2, 0))],
    [1, true, true, true]);

  const one = sandbox();
  fs.writeFileSync(one.target('.tokensave/state.toml'), state('["claude"]'));
  check('installed_agents в одну строку — агент назван', one.run().out.includes('записал агентов: claude —'), true);

  for (const agents of ['[\n    "claude",\n]', '["claude"]']) {
    const fix = sandbox();
    const stateFile = fix.target('.tokensave/state.toml');
    fs.writeFileSync(stateFile, state(agents));
    const fixRules = fix.target('.claude/rules/tokensave.md');
    fs.writeFileSync(fixRules, 'правила tokensave');
    const res = fix.run([]);
    const baks = fs.readdirSync(path.dirname(fixRules)).filter((n) => n.startsWith('tokensave.md.bak-'));
    check(`install чистит следы tokensave install (${JSON.stringify(agents)}): агентов нет, правила в .bak`,
      [read(stateFile), fs.existsSync(fixRules), baks.length, res.out.includes('installed_agents очищен (было: claude)')],
      [state('[]'), false, 1, true]);
    check(`после чистки (${JSON.stringify(agents)}) --check без следов`, fix.run().out.includes(summary(ALL, 0, 0)), true);
  }
}

{
  const sb = sandbox();
  const [bashrc, env] = ['.bashrc', '.config/harness/env'].map(sb.target);
  fs.writeFileSync(path.join(sb.harness, 'shell', 'bashrc'), "alias ll='ls -alF'\n");
  fs.writeFileSync(env, 'export GITLAB_HOST=""\n');
  const brew = 'eval "$(/home/linuxbrew/.linuxbrew/bin/brew shellenv)"';
  const conda = '# >>> conda initialize >>>\nif [ -f x ]; then\n    . x\nfi\n# <<< conda initialize <<<';
  fs.rmSync(bashrc);
  fs.writeFileSync(bashrc, [
    'case $- in', '    *i*) ;;', '      *) return;;', 'esac',
    "alias ll='ls -alF'", 'export GITLAB_HOST=""', 'if true; then', '    export INSIDE=1', 'fi',
    brew, '. "$HOME/.cargo/env"', conda,
    'export NVM_DIR="$HOME/.nvm"', '[ -s "$NVM_DIR/nvm.sh" ] && \\. "$NVM_DIR/nvm.sh"', 'export PATH="$HOME/.local/bin:$PATH"',
  ].join('\n') + '\n');
  const res = sb.run([]);
  const moved = [brew, '. "$HOME/.cargo/env"', conda].join('\n');
  check('install переносит строки настройки из бэкапа ~/.bashrc в env',
    read(env).replace(/^# Перенесено install\.sh из ~\/\.bashrc\.bak-[\d-]+: .*\n/m, ''), `export GITLAB_HOST=""\n\n${moved}\n`);
  check('перенос назван в выводе', [res.out.includes(`${env} — дописаны строки из .bashrc.bak-`), res.out.includes(`  ${brew}\n`)], [true, true]);
  const once = read(env);
  sb.run([]);
  check('повторный install ничего не дописывает', read(env), once);
}

{
  const gitSandbox = (tools) => {
    const sb = sandbox({ tools });
    const [gitconfig, local] = ['.gitconfig', '.gitconfig.local'].map(sb.target);
    fs.writeFileSync(path.join(sb.harness, 'git', 'gitconfig'), '[pull]\n\trebase = true\n[include]\n\tpath = ~/.gitconfig.local\n');
    fs.writeFileSync(local, '[alias]\n\tst = status\n');
    fs.rmSync(gitconfig);
    fs.writeFileSync(gitconfig, [
      '[user]', '\tname = Dev', '\temail = dev@example.com',
      '[pull]', '\trebase = true',
      '[alias]', '\tst = status',
      '[credential]', '\thelper =', '\thelper = manager',
      '[safe]', '\tdirectory = *',
      '[include]', '\tpath = ~/.gitconfig.local',
      '',
    ].join('\n'));
    return { sb, local };
  };
  const { sb, local } = gitSandbox([...TOOLS, 'git']);
  const res = sb.run([]);
  const list = () => spawnSync('git', ['config', '-f', local, '--list'], { encoding: 'utf8' }).stdout;
  check('install переносит из бэкапа ~/.gitconfig то, чего нет в git/gitconfig и в local, порядок хелперов сохранён', list(), [
    'alias.st=status', 'user.name=Dev', 'user.email=dev@example.com',
    'credential.helper=', 'credential.helper=manager', 'safe.directory=*', '',
  ].join('\n'));
  check('перенос gitconfig назван в выводе ключами, без значений',
    [res.out.includes(`${local} — перенесены настройки из .gitconfig.bak-`), res.out.includes('  user.email\n'), res.out.includes('dev@example.com'), res.out.includes('pull.rebase')],
    [true, true, false, false]);
  const once = list();
  sb.run([]);
  check('повторный install ничего не дописывает в ~/.gitconfig.local', list(), once);

  const nogit = gitSandbox(TOOLS);
  const out = nogit.sb.run([]).out;
  check('git нет — ✗ и local не тронут',
    [out.includes('✗ git не найден — настройки из .gitconfig.bak-'), read(nogit.local)], [true, '[alias]\n\tst = status\n']);
}

{
  const sb = sandbox();
  const env = sb.target('.config/harness/env');
  fs.writeFileSync(path.join(sb.harness, 'shell', 'bashrc'), "alias ll='ls -alF'\n");
  fs.mkdirSync(path.join(sb.home, 'tools', 'bin'), { recursive: true });
  fs.writeFileSync(path.join(sb.home, 'tools', 'env'), '');
  fs.writeFileSync(env, [
    'export GITLAB_HOST=""',
    'eval "$(/nowhere/brew shellenv)"',
    'export PATH="$HOME/tools/bin:$HOME/gone:$PATH"',
    '. "$HOME/tools/env"',
    '[ -f ~/missing.sh ] && . ~/missing.sh',
    'export GITLAB_HOST=""',
    "alias ll='ls -alF'",
    'export PNPM_HOME="$HOME/.local/share/pnpm"',
    '# >>> conda initialize >>>', 'if [ -f x ]; then', 'fi', '# <<< conda initialize <<<',
    '# >>> mamba initialize >>>', 'if [ -f x ]; then', 'fi', '# <<< mamba initialize <<<',
    '',
  ].join('\n'));
  const before = sb.snap();
  const res = sb.run();
  const flagged = [...res.out.matchAll(/^ {2}! .*env:(\d+) — (.*)$/gm)].map(([, n, why]) => `${n}: ${why}`);
  check('env_check: мёртвые пути, дубли и строки shell/bashrc — по строкам', flagged, [
    '2: нет бинаря /nowhere/brew',
    `3: нет каталога ${sb.home}/gone в PATH`,
    `5: нет файла ${sb.home}/missing.sh`,
    '6: дубль строки 1',
    '7: это уже ставит shell/bashrc',
    '8: это уже ставит shell/bashrc',
  ]);
  check('env_check: +1 к вниманию, код 1, файл не тронут',
    [res.status, res.out.includes(summary(ALL, 1, 0)), changes(before, sb.snap())], [1, true, []]);
}

{
  const sb = sandbox();
  const res = sb.run();
  check('внешних бинарей нет — названы, код не меняют',
    [res.status, res.out.includes('claude — не найден'), res.out.includes('tokensave — не найден'), res.out.includes('python3 — не найден')],
    [0, true, true, true]);
  check('tokensave не найден, state.toml нет — откуда взять, без версии',
    [res.out.includes('релизов https://github.com/aovestdipaperino/tokensave'), res.out.includes('здесь стояла')], [true, false]);
}

{
  const sb = sandbox();
  fs.writeFileSync(sb.target('.tokensave/state.toml'), 'last_installed_version = ""\nprevious_version = "7.16.0"\ninstalled_agents = []\n');
  check('tokensave не найден — версия из state.toml, пустая last_installed_version пропущена',
    sb.run().out.includes('здесь стояла 7.16.0'), true);
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
