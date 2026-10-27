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
const CLAUDE_DIFF = path.join(path.dirname(ROOT), 'bin', 'claude-diff.mjs');
// Пары target|source из массива install.sh; $RAG_HOME без RAGSAVE_HOME — ~/.rag-mcp.
const pairs = (name) => {
  const block = fs.readFileSync(INSTALL, 'utf8').match(new RegExp(`^${name}=\\(\\n([\\s\\S]*?)^\\)`, 'm'))[1];
  return [...block.matchAll(/^\s*"\$(HOME|RAG_HOME)\/([^|"]+)\|([^"]+)"$/gm)]
    .map(([, base, target, src]) => ({ target: base === 'RAG_HOME' ? `.rag-mcp/${target}` : target, src }));
};
// Ядро и личное (--personal): песочница по умолчанию с меткой личного — цели обоих.
const CORE_LINKS = pairs('LINKS');
const CORE_LOCALS = pairs('LOCALS');
const LINKS = [...CORE_LINKS, ...pairs('PERSONAL_LINKS')];
const LOCALS = [...CORE_LOCALS, ...pairs('PERSONAL_LOCALS')];
const ALL = LINKS.length + LOCALS.length;
const CORE = CORE_LINKS.length + CORE_LOCALS.length;
const MARK = '.config/harness/personal';
// mkdir/mv/ln/rm/cp --check не нужны; они в PATH, чтобы правку, если она случится, поймал снимок.
const TOOLS = ['date', 'dirname', 'basename', 'readlink', 'grep', 'head', 'sed', 'awk', 'node', 'diff', 'mkdir', 'mv', 'ln', 'rm', 'cp'];
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

function sandbox({ settings = '{}', tools = TOOLS, fakes = [], personal = true } = {}) {
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
  fs.symlinkSync(CLAUDE_DIFF, path.join(harness, 'bin', 'claude-diff.mjs'));
  fs.symlinkSync(INSTALL, path.join(harness, 'install.sh'));

  const bin = path.join(home, 'path');
  fs.mkdirSync(bin);
  for (const t of tools) {
    fs.symlinkSync(spawnSync(BASH, ['-c', `command -v ${t}`], { encoding: 'utf8' }).stdout.trim(), path.join(bin, t));
  }
  for (const f of fakes) fs.symlinkSync(FAKE, path.join(bin, f));

  // Все цели — верные симлинки; сценарий портит нужные. Без личного
  // ~/.bashrc свой и уже подключает ядро.
  const target = (t) => path.join(home, t);
  if (personal) {
    fs.mkdirSync(path.dirname(target(MARK)), { recursive: true });
    fs.writeFileSync(target(MARK), '');
  } else {
    fs.writeFileSync(target('.bashrc'), 'свой bashrc\n# >>> harness >>>\n');
  }
  for (const { target: t, src } of personal ? LINKS : CORE_LINKS) {
    fs.mkdirSync(path.dirname(target(t)), { recursive: true });
    fs.symlinkSync(path.join(harness, src), target(t));
  }
  // Локальные файлы — уже заполненные копии.
  for (const { target: t } of personal ? LOCALS : CORE_LOCALS) {
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
check('ядро без личного: ~/.bashrc, ~/.gitconfig, клавиши и ~/.gitconfig.local — только в PERSONAL_*',
  [...CORE_LINKS, ...CORE_LOCALS].filter((l) => ['.bashrc', '.gitconfig', '.gitignore_global', '.claude/keybindings.json', '.gitconfig.local'].includes(l.target)), []);

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
  const zshenv = sb.target('.zshenv');
  fs.rmSync(zshenv);
  const res = sb.run();
  check('без zsh и ~/.zshenv — --check не считает его расхождением',
    [res.status, res.out.includes(summary(ALL - 1, 0, 0)), res.out.includes(`${zshenv} — нет`)], [0, true, false]);
  sb.run(['install']);
  check('без zsh install не создаёт ~/.zshenv', fs.existsSync(zshenv), false);
}

{
  const sb = sandbox({ fakes: ['zsh'] });
  const zshenv = sb.target('.zshenv');
  fs.rmSync(zshenv);
  check('zsh есть — --check называет отсутствующий ~/.zshenv', sb.run().out.includes(`${zshenv} — нет`), true);
  sb.run(['install']);
  check('zsh есть — install ставит ~/.zshenv', fs.readlinkSync(zshenv), path.join(sb.harness, 'shell', 'zshenv'));
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
  const bare = sandbox({ settings: hooks('tokensave'), fakes: ['tokensave'] });
  const bareRes = bare.run();
  check('хуки tokensave зовут голое имя — ✓ с путём из PATH, код 0',
    [bareRes.status, bareRes.out.includes(`✓ хуки tokensave в claude/settings.json зовут tokensave из PATH: ${path.join(bare.home, 'path', 'tokensave')}`)],
    [0, true]);
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
    brew, '. "$HOME/.cargo/env"', 'export API_TOKEN="s3cret"', conda,
    'export NVM_DIR="$HOME/.nvm"', '[ -s "$NVM_DIR/nvm.sh" ] && \\. "$NVM_DIR/nvm.sh"', 'export PATH="$HOME/.local/bin:$PATH"',
  ].join('\n') + '\n');
  const res = sb.run([]);
  const moved = [brew, '. "$HOME/.cargo/env"', 'export API_TOKEN="s3cret"', conda].join('\n');
  check('install переносит строки настройки из бэкапа ~/.bashrc в env',
    read(env).replace(/^# Перенесено install\.sh из ~\/\.bashrc\.bak-[\d-]+: .*\n/m, ''), `export GITLAB_HOST=""\n\n${moved}\n`);
  check('перенос назван в выводе, у export — только имя',
    [res.out.includes(`${env} — дописаны строки из .bashrc.bak-`), res.out.includes(`  ${brew}\n`), res.out.includes('  export API_TOKEN\n'), res.out.includes('s3cret')],
    [true, true, true, false]);
  const once = read(env);
  sb.run([]);
  check('повторный install ничего не дописывает', read(env), once);
}

{
  const sb = sandbox();
  const [zshenv, env] = ['.zshenv', '.config/harness/env'].map(sb.target);
  const brew = 'eval "$(/opt/homebrew/bin/brew shellenv)"';
  fs.writeFileSync(path.join(sb.harness, 'shell', 'zshenv'), `if true; then\n  ${brew}\nfi\n`);
  fs.writeFileSync(env, 'export GITLAB_HOST=""\n');
  fs.rmSync(zshenv);
  fs.writeFileSync(zshenv, `. "$HOME/.cargo/env"\n${brew}\n`);
  const res = sb.run([]);
  check('install переносит строки из бэкапа ~/.zshenv в env, своё shell/zshenv — нет',
    read(env).replace(/^# Перенесено install\.sh из ~\/\.zshenv\.bak-[\d-]+: строк нет в shell\/zshenv\.\n/m, ''),
    'export GITLAB_HOST=""\n\n. "$HOME/.cargo/env"\n');
  check('~/.zshenv — симлинк на shell/zshenv, перенос назван',
    [fs.readlinkSync(zshenv), res.out.includes(`${env} — дописаны строки из .zshenv.bak-`)],
    [path.join(sb.harness, 'shell', 'zshenv'), true]);
}

{
  const sb = sandbox();
  const today = spawnSync('date', ['+%Y%m%d-%H%M%S'], { encoding: 'utf8' }).stdout.trim();
  const [oldRc, freshRc, oldSkills] = ['.bashrc.bak-20200101-000000', `.bashrc.bak-${today}`, '.claude/skills.bak-20200101-000000'].map(sb.target);
  fs.writeFileSync(oldRc, '');
  fs.writeFileSync(freshRc, '');
  fs.mkdirSync(oldSkills);
  const res = sb.run();
  check('--check называет бэкапы старше 30 дней, свежий молчит, drift не растёт',
    [res.out.includes(`${oldRc} — бэкап старше 30 дней`), res.out.includes(`${oldSkills} — бэкап старше 30 дней`),
      res.out.includes(freshRc), res.out.includes('/doctor спросит, какие удалить'), res.out.includes(summary(ALL, 0, 0))],
    [true, true, false, true, true]);
  check('без старых бэкапов строки нет', sandbox().run().out.includes('бэкап'), false);
}

// macOS: BSD date — `-d` ошибка, `-v-30d` работает; uname — Darwin.
const REAL_DATE = spawnSync(BASH, ['-c', 'command -v date'], { encoding: 'utf8' }).stdout.trim();
function fakeScript(sb, name, body) {
  fs.writeFileSync(path.join(sb.home, 'path', name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
}
function macSandbox() {
  const sb = sandbox({ tools: TOOLS.filter((t) => t !== 'date') });
  fakeScript(sb, 'date', [
    'case "$1" in',
    '  -d) echo "date: illegal option -- d" >&2; exit 1 ;;',
    `  -v-30d) shift; exec ${REAL_DATE} -d "30 days ago" "$@" ;;`,
    'esac',
    `exec ${REAL_DATE} "$@"`,
  ].join('\n'));
  fakeScript(sb, 'uname', 'echo Darwin');
  return sb;
}

{
  const sb = macSandbox();
  const old = sb.target('.bashrc.bak-20200101-000000');
  fs.writeFileSync(old, '');
  check('BSD date — старый бэкап всё равно назван', sb.run().out.includes(`${old} — бэкап старше 30 дней`), true);
}

{
  const sb = macSandbox();
  const dir = sb.target('Library/Application Support/Code/User');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'settings.json'), 'свои');
  fs.mkdirSync(path.join(sb.harness, 'vscode', 'snippets'), { recursive: true });
  for (const f of ['settings.json', 'keybindings.json']) fs.writeFileSync(path.join(sb.harness, 'vscode', f), '');
  const names = ['settings.json', 'keybindings.json', 'snippets'];

  const before = sb.run();
  sb.run([]);
  const after = sb.run();

  check('macOS: --check до install называет VS Code и даёт код 1',
    [before.status, before.out.includes(`${dir}/settings.json — обычный файл`), before.out.includes(`${dir}/snippets — нет`)], [1, true, true]);
  check('macOS: install ставит симлинки VS Code в Library/Application Support',
    names.map((n) => (fs.lstatSync(path.join(dir, n), { throwIfNoEntry: false })?.isSymbolicLink() ? fs.readlinkSync(path.join(dir, n)) : null)), names.map((n) => path.join(sb.harness, 'vscode', n)));
  check('macOS: прежний settings.json уехал в .bak-<дата>',
    fs.readdirSync(dir).filter((f) => f.startsWith('settings.json.bak-')).map((f) => read(path.join(dir, f))), ['свои']);
  check('macOS: --check после install признаёт симлинки VS Code',
    [after.status, names.every((n) => after.out.includes(`✓ ${dir}/${n}\n`)), after.out.includes(summary(ALL + 3, 0, 0))], [0, true, true]);
}

{
  const sb = sandbox();
  fs.mkdirSync(sb.target('Library/Application Support/Code/User'), { recursive: true });
  check('не macOS — каталог Library не трогается', sb.run().out.includes('Library'), false);
}

{
  const sb = sandbox();
  const project = (name, files, cwd = sb.target(name)) => {
    const dir = sb.target(`.claude/projects/-${name}`);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 's.jsonl'), `{"type":"summary"}\n${JSON.stringify({ type: 'user', cwd })}\n`);
    for (const f of files) {
      fs.mkdirSync(path.dirname(sb.target(`${name}/${f}`)), { recursive: true });
      fs.writeFileSync(sb.target(`${name}/${f}`), '');
    }
  };
  project('bare', ['.git']);
  project('tsonly', ['.git', '.tokensave/db', '.ragsave-disable']);
  project('ragonly', ['.git', '.ragsave/rag.db']);
  project('full', ['.git', '.tokensave/db', '.ragsave/rag.db']);
  project('nogit', []);
  project('home', [], sb.home);
  const out = sb.run().out;
  const line = (name) => out.split('\n').find((l) => l.includes(`${sb.target(name)} — нет индекса`)) ?? '';
  check('--check называет git-проекты сессий без индекса и одну команду на каждый',
    [line('bare').endsWith(`нет индекса: tokensave init ${sb.target('bare')}`),
      line('ragonly').endsWith(`нет индекса: tokensave init ${sb.target('ragonly')}`),
      line('tsonly'), line('full'), line('nogit'), out.includes(`${sb.home} — нет индекса`), out.includes(summary(ALL, 0, 0))],
    [true, true, '', '', '', false, true]);
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

// Настроенная машина: свои settings.json, скиллы и CLAUDE.md вместо симлинков.
function configuredSandbox(tools) {
  const sb = sandbox({
    tools,
    settings: JSON.stringify({ permissions: { allow: ['Bash(ls *)'] }, hooks: { Stop: [{ hooks: [{ type: 'command', command: 'node ~/.ai-hooks/claude/stop.mjs' }] }] } }),
  });
  const [settings, skills, claudeMd] = ['.claude/settings.json', '.claude/skills', '.claude/CLAUDE.md'].map(sb.target);
  fs.rmSync(path.join(sb.harness, 'skills'));
  for (const name of ['doctor', 'git-flow']) {
    fs.mkdirSync(path.join(sb.harness, 'skills', name), { recursive: true });
    fs.writeFileSync(path.join(sb.harness, 'skills', name, 'SKILL.md'), `# ${name}\n`);
  }
  fs.writeFileSync(path.join(sb.harness, 'claude', 'CLAUDE.md'), '# rules\n');
  for (const t of [settings, skills, claudeMd]) fs.rmSync(t);
  fs.writeFileSync(settings, JSON.stringify({
    model: 'opus',
    env: { SECRET_TOKEN: 'xyz' },
    permissions: { allow: ['Bash(ls *)', 'Bash(make *)'] },
    hooks: { Stop: [{ hooks: [{ type: 'command', command: 'node ~/.ai-hooks/claude/stop.mjs' }] }], PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: '~/bin/guard.sh' }] }] },
  }));
  for (const [name, text] of [['my-skill', 'my'], ['doctor', 'changed'], ['git-flow', '# git-flow\n'], ['.cache', '']]) {
    fs.mkdirSync(path.join(skills, name), { recursive: true });
    fs.writeFileSync(path.join(skills, name, 'SKILL.md'), text);
  }
  fs.writeFileSync(claudeMd, '# rules\nmy rule 1\nmy rule 2\n');
  return sb;
}
const REPORT = [
  '  env.SECRET_TOKEN\n', '  permissions.allow: Bash(make *)\n', '  hooks.PreToolUse[Bash]: ~/bin/guard.sh\n',
  '  свой: my-skill\n', '  изменён: doctor\n', 'строк своих: 2', '/doctor перенесёт каждый пункт',
];
const reported = (out) => REPORT.filter((s) => !out.includes(s));
const LEAKS = ['xyz', 'model', 'git-flow', '.cache', 'Bash(ls *)', 'stop.mjs'];

{
  const sb = configuredSandbox();
  const before = sb.snap();
  const res = sb.run();
  check('--check на настроенной машине — своё названо заранее, код 1, HOME не тронут',
    [reported(res.out), res.status, changes(before, sb.snap())], [[], 1, []]);
  check('--check: значения env, model, общие скиллы, скрытые и общие ключи не названы',
    LEAKS.filter((s) => res.out.includes(s)), []);
  check('--check: отчёт не добавляет к вниманию — только три обычных файла', res.out.includes(summary(ALL - 3, 3, 0)), true);
}

{
  const sb = configuredSandbox();
  const res = sb.run([]);
  const baks = fs.readdirSync(sb.target('.claude')).filter((n) => n.includes('.bak-'));
  check('install на настроенной машине — тот же отчёт по .bak-<дата>, без значений',
    [reported(res.out), LEAKS.filter((s) => res.out.includes(s)), res.out.includes(`${sb.target('.claude/settings.json')}.bak-`)], [[], [], true]);
  check('install: своё осталось в бэкапах, в харнесс не записано',
    [baks.map((n) => n.replace(/\.bak-.*/, '')).sort(), fs.existsSync(path.join(sb.harness, 'skills', 'my-skill'))],
    [['CLAUDE.md', 'settings.json', 'skills'], false]);
  check('--check после install — всё симлинки, отчёта нет', sb.run().out.includes('/doctor перенесёт'), false);
}

{
  const sb = configuredSandbox(TOOLS.filter((t) => t !== 'node'));
  const out = sb.run().out;
  check('node нет — json не сравнён, каталоги и текст — да',
    [out.includes('settings.json — node не найден, свои ключи не сравнены'), out.includes('свой: my-skill'), out.includes('строк своих: 2')],
    [true, true, true]);
}

{
  const sb = sandbox();
  const settings = sb.target('.claude/settings.json');
  fs.rmSync(settings);
  fs.writeFileSync(settings, '{ broken');
  check('битый settings.json — сравнить руками', sb.run().out.includes('settings.json не разобран как JSON — сравнить руками'), true);
}

for (const [dir, warned] of [['~/.githooks', true], ['~/.config/git/hooks', false]]) {
  const sb = sandbox({ tools: [...TOOLS, 'git'] });
  const [gitconfig, local] = ['.gitconfig', '.gitconfig.local'].map(sb.target);
  fs.writeFileSync(path.join(sb.harness, 'git', 'gitconfig'), '[core]\n\thooksPath = ~/.config/git/hooks\n');
  fs.writeFileSync(local, '');
  fs.rmSync(gitconfig);
  fs.writeFileSync(gitconfig, `[core]\n\thooksPath = ${dir}\n`);
  const res = sb.run([]);
  check(`core.hooksPath = ${dir} из бэкапа не переносится в local, ${warned ? 'предупреждение с каталогом' : 'тихо'}`,
    [read(local), res.out.includes(`core.hooksPath = ${dir} из .gitconfig.bak-`), res.out.includes('core.hookspath')],
    ['', warned, false]);
}

for (const [hooks, warned] of [['~/.config/git/hooks', true], ['~/.husky', false], ['', false]]) {
  const sb = sandbox({ tools: [...TOOLS, 'git'] });
  fs.writeFileSync(path.join(sb.harness, 'git', 'gitconfig'), hooks ? `[core]\n\thooksPath = ${hooks}\n` : '');
  check(`hooksPath ${hooks || 'не задан'} — ${warned ? 'хуки tokensave проверяются' : 'externals молчит'}`,
    sb.run().out.includes('глобальных git-хуков tokensave нет'), warned);
}

for (const [helper, warned] of [['', true], ['[credential "https://gitlab.example.com"]\n\thelper = store\n', false]]) {
  const sb = sandbox({ tools: [...TOOLS, 'git'] });
  fs.writeFileSync(path.join(sb.harness, 'git', 'gitconfig'), '[include]\n\tpath = ~/.gitconfig.local\n');
  fs.writeFileSync(sb.target('.gitconfig.local'), helper);
  fs.writeFileSync(sb.target('.git-credentials'), '');
  check(`~/.git-credentials ${warned ? 'без хелпера store — предупреждение' : 'и store для хоста в local — тихо'}`,
    sb.run().out.includes('credential.helper store не задан'), warned);
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
    '7: это уже ставит харнесс',
    '8: это уже ставит харнесс',
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

// Версия node: подменный `node` печатает заданную строку на любой вызов.
const nodeVersion = (ver) => {
  const sb = sandbox({ tools: TOOLS.filter((t) => t !== 'node') });
  const fake = path.join(sb.home, 'path', 'node');
  fs.writeFileSync(fake, `#!/bin/sh\necho ${ver}\n`, { mode: 0o755 });
  return sb.run().out;
};
for (const [ver, ok] of [['v20.0.0', false], ['v22.12.9', false], ['v23.3.0', false], ['v9.0.0', false],
  ['v22.13.0', true], ['v23.4.0', true], ['v24.18.0', true], ['v100.0.0', true]]) {
  const out = nodeVersion(ver);
  check(`node ${ver} — ${ok ? 'принят' : 'старше минимума'}`,
    [out.includes(`✓ node ${ver}`), out.includes(`✗ node ${ver} ниже минимума 22.13/23.4`)], [ok, !ok]);
}
check('версия node не разобрана — предупреждение', nodeVersion('мусор').includes('node: версию не разобрать'), true);

// node в неинтерактивном zsh: подменный zsh печатает путь или ничего.
for (const [shellNode, ok] of [['/opt/homebrew/bin/node', true], ['', false]]) {
  const sb = sandbox();
  fs.writeFileSync(path.join(sb.home, 'path', 'zsh'), `#!/bin/sh\necho '${shellNode}'\n`, { mode: 0o755 });
  const res = sb.run(['--check'], { SHELL: '/bin/zsh' });
  check(`zsh ${ok ? 'видит' : 'не видит'} node — ${ok ? '✓' : '✗ и drift'}`,
    [res.out.includes('✓ node виден неинтерактивному zsh'), res.out.includes('✗ node не виден неинтерактивному zsh')], [ok, !ok]);
}
{
  const sb = sandbox();
  fs.writeFileSync(path.join(sb.home, 'path', 'zsh'), '#!/bin/sh\necho\n', { mode: 0o755 });
  const out = sb.run(['--check'], { SHELL: '/bin/bash' }).out;
  check('$SHELL не zsh — проверка пропущена', out.includes('неинтерактивному zsh'), false);
}

{
  const sb = sandbox();
  const before = sb.snap();
  const res = sb.run(['--bogus']);
  check('неизвестный режим — код 2 и usage', [res.status, res.out.includes('Использование: ./install.sh [--personal|--check|--venv]')], [2, true]);
  check('неизвестный режим — ничего не меняет', changes(before, sb.snap()), []);
}

// Только ядро: чужая машина со своими ~/.bashrc, ~/.gitconfig и клавишами Claude Code.
{
  const sb = sandbox({ personal: false });
  check('ядро на месте — код 0, счёт без личного, блок в ~/.bashrc засчитан',
    [sb.run().status, sb.run().out.includes(summary(CORE + 1, 0, 0)), sb.run().out.includes('только ядро (личное — ./install.sh --personal)')], [0, true, true]);
}

{
  const sb = sandbox({ personal: false });
  const [bashrc, gitconfig, keys, gitLocal] = ['.bashrc', '.gitconfig', '.claude/keybindings.json', '.gitconfig.local'].map(sb.target);
  fs.writeFileSync(bashrc, 'свой bashrc\n');
  fs.writeFileSync(gitconfig, '[user]\n\tname = Dev\n');
  fs.writeFileSync(keys, '{"bindings": []}');
  const check1 = sb.run();
  check('ядро: --check называет ~/.bashrc без блока, свои gitconfig и клавиши не трогает',
    [check1.status, check1.out.includes(`${bashrc} — не подключает ~/.config/harness/bashrc`), /gitconfig|keybindings/.test(check1.out)], [1, true, false]);
  sb.run([]);
  sb.run([]);
  check('ядро: install дописывает блок в свой ~/.bashrc один раз, личное не ставит',
    [read(bashrc).startsWith('свой bashrc\n'), read(bashrc).split('# >>> harness >>>').length - 1, read(gitconfig), read(keys),
      fs.existsSync(gitLocal), fs.existsSync(sb.target(MARK)), fs.readdirSync(sb.home).some((n) => n.includes('.bak-'))],
    [true, 1, '[user]\n\tname = Dev\n', '{"bindings": []}', false, false, false]);
  check('ядро: блок подключает ~/.config/harness/bashrc', read(bashrc).includes('. "$HOME/.config/harness/bashrc"'), true);
  check('ядро: --check после install — код 0', [sb.run().status, sb.run().out.includes(summary(CORE + 1, 0, 0))], [0, true]);

  fs.rmSync(bashrc);
  sb.run([]);
  check('ядро: нет ~/.bashrc — install создаёт его с одним блоком', read(bashrc).trim().split('\n').length, 3);

  const res = sb.run(['--personal']);
  check('--personal: метка, личные симлинки, прежние файлы в .bak, local из шаблона',
    [fs.existsSync(sb.target(MARK)), fs.readlinkSync(bashrc), fs.readlinkSync(gitconfig), read(gitLocal), res.out.includes('ядро и личное')],
    [true, path.join(sb.harness, 'shell', 'bashrc'), path.join(sb.harness, 'git', 'gitconfig'), 'шаблон local/gitconfig.local.example', true]);
  check('после --personal обычный --check ведёт личное по метке', sb.run().out.includes(summary(ALL, 0, 0)), true);
}

{
  const sb = sandbox({ personal: false });
  const env = sb.target('.config/harness/env');
  fs.writeFileSync(env, 'export PNPM_HOME="$HOME/.local/share/pnpm"\nexport PATH="$HOME/.local/bin:$PATH"\n');
  const flagged = [...sb.run().out.matchAll(/^ {2}! .*env:(\d+) — (.*)$/gm)].map(([, n, why]) => `${n}: ${why}`);
  check('ядро: свой pnpm в env не дубль, ~/.local/bin — дубль ядра', flagged, ['2: это уже ставит харнесс']);
}

// --venv: venv уже собран (фейк на месте python), pip — тот же фейк; `pip list`
// отвечает пакетами старого venv.
function venvRun(gpu, installed) {
  const sb = sandbox({ fakes: gpu ? ['nvidia-smi'] : [] });
  const py = sb.target('.rag-mcp/venv/bin/python');
  fs.mkdirSync(path.dirname(py), { recursive: true });
  fs.symlinkSync(FAKE, py);
  fs.mkdirSync(path.join(sb.harness, 'ragsave'), { recursive: true });
  fs.writeFileSync(path.join(sb.harness, 'ragsave', 'requirements.txt'), 'fastembed==0.8.0\nnvidia-cublas==13.8.1.7\nonnxruntime-gpu==1.28.0\n');
  const req = path.join(sb.home, 'req.txt');
  const res = sb.run(['--venv'], { FAKE_INDEXER_REQ: req, FAKE_INDEXER_LIST: installed.map((p) => `${p}\n`).join('') });
  // Вызовы pip после `pip install -r`: удаление чужого и переустановка своего.
  const after = res.calls.slice(res.calls.findIndex((c) => c.includes('-r')) + 1).map((c) => c.slice(1).join(' '));
  return { ...res, req: read(req), after };
}

for (const gpu of [true, false]) {
  const res = venvRun(gpu, ['fastembed==0.8.0', gpu ? 'onnxruntime-gpu==1.28.0' : 'onnxruntime==1.28.0']);
  check(`--venv ${gpu ? 'с GPU — onnxruntime-gpu и nvidia-*' : 'без nvidia-smi — CPU-сборка той же версии без nvidia-*'}, чужой сборки нет — ничего не удаляется`,
    [res.status, res.req, res.after, res.out.includes(gpu ? 'на GPU' : 'на CPU')],
    [0, gpu ? 'fastembed==0.8.0\nnvidia-cublas==13.8.1.7\nonnxruntime-gpu==1.28.0\n' : 'fastembed==0.8.0\nonnxruntime==1.28.0\n', [], true]);
}

{
  const res = venvRun(true, ['onnxruntime==1.28.0', 'onnxruntime-gpu==1.28.0', 'nvidia-cublas==13.8.1.7']);
  check('--venv с GPU, в venv обе сборки — CPU снята, своя переустановлена поверх общего каталога',
    [res.status, res.after],
    [0, ['pip uninstall --quiet -y onnxruntime', 'pip install --quiet --no-deps --force-reinstall onnxruntime-gpu==1.28.0']]);
}

{
  const res = venvRun(false, ['fastembed==0.8.0', 'onnxruntime_gpu==1.28.0', 'nvidia-cublas==13.8.1.7', 'nvidia-cudnn-cu12==9.1.0']);
  check('--venv GPU→CPU — GPU-сборка снята, CPU переустановлена, nvidia-* удалены',
    [res.status, res.after],
    [0, ['pip uninstall --quiet -y onnxruntime-gpu', 'pip install --quiet --no-deps --force-reinstall onnxruntime==1.28.0',
      'pip uninstall --quiet -y nvidia-cublas nvidia-cudnn-cu12']]);
}

{
  // Системный python macOS: нет enable_load_extension — фейк на `-c` выходит с 1.
  const sb = sandbox({ fakes: ['python3'] });
  const res = sb.run(['--venv'], { FAKE_INDEXER_EXIT: '1' });
  check('--venv: python без расширений sqlite — код 1, подсказка brew, venv не создаётся',
    [res.status, res.out.includes('без sqlite3 enable_load_extension'), res.out.includes('brew install python'),
      res.calls.length, fs.existsSync(sb.target('.rag-mcp/venv'))],
    [1, true, true, 1, false]);
}

process.stdout.write(failed ? `\n=== ${failed} проверок упало ===\n` : '\n=== все проверки прошли ===\n');
process.exit(failed ? 1 : 0);
