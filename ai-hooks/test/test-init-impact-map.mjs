#!/usr/bin/env node
// Тесты создания первой карты неявных связей. Ловится то, ради чего скрипт
// написан: карта в проекте без графа, карта в чужую историю, вторая карта
// поверх существующей. Гоняется на временных git-репозиториях.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SCRIPT = path.join(ROOT, 'bin', 'init-impact-map.mjs');
const CHECK = path.join(ROOT, 'bin', 'check-impact-map.mjs');
const ME = 'me@example.test';

let failed = 0;
function check(name, ok, detail = '') {
  process.stdout.write(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok || !detail ? '' : ` — ${detail}`}\n`);
  if (!ok) failed++;
}

function git(dir, args, email = ME) {
  return execFileSync('git', ['-c', `user.name=${email}`, '-c', `user.email=${email}`, ...args], {
    cwd: dir,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
}

// Песочница: git-репозиторий с одним коммитом от каждого из authors и,
// по умолчанию, с БД tokensave — признаком, что граф есть.
function project({ authors = [ME], tokensave = true, files = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'init-impact-map-test-'));
  git(dir, ['init', '-q']);
  git(dir, ['config', 'user.email', ME]);
  git(dir, ['config', 'user.name', ME]);
  if (tokensave) {
    fs.mkdirSync(path.join(dir, '.tokensave'));
    fs.writeFileSync(path.join(dir, '.tokensave', 'tokensave.db'), '');
  }
  for (const [rel, body] of Object.entries(files)) {
    const file = path.join(dir, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, body);
  }
  for (const [i, author] of authors.entries()) {
    fs.writeFileSync(path.join(dir, `f${i}.txt`), `${i}\n`);
    git(dir, ['add', '-A'], author);
    git(dir, ['commit', '-q', '-m', `c${i}`], author);
  }
  return dir;
}

function run(script, dir) {
  try {
    return { code: 0, out: execFileSync('node', [script, dir], { encoding: 'utf8' }) };
  } catch (e) {
    return { code: e.status, out: e.stdout || '' };
  }
}

// Нет графа — нечего дополнять, карта не заводится.
{
  const dir = project({ tokensave: false });
  const { code, out } = run(SCRIPT, dir);
  check('без .tokensave карта не создаётся', code === 0 && out.includes('нет .tokensave'), out.trim());
  check('без .tokensave каталога нет', !fs.existsSync(path.join(dir, 'docs/links')) && !fs.existsSync(path.join(dir, '.claude/links')));
}

// Свой репозиторий — карта коммитится в docs/links.
{
  const dir = project();
  const { code, out } = run(SCRIPT, dir);
  const index = path.join(dir, 'docs/links/INDEX.md');
  check('свой репозиторий → docs/links', code === 0 && out.includes('создана docs/links/INDEX.md'), out.trim());
  check('INDEX.md с заголовком', fs.existsSync(index) && fs.readFileSync(index, 'utf8').startsWith('# Карта скрытых связей'));
  const checked = run(CHECK, dir);
  check('скелет проходит check-impact-map', checked.code === 0 && checked.out.includes('все ссылки разрешились'), checked.out.trim());
  const again = run(SCRIPT, dir);
  check('второй запуск не трогает карту', again.code === 0 && again.out.includes('уже есть'), again.out.trim());
}

// Чужой автор в истории — карта уходит в игнорируемый .claude/links.
{
  const dir = project({ authors: [ME, 'other@example.test'] });
  const { code, out } = run(SCRIPT, dir);
  check('чужой автор → .claude/links', code === 0 && out.includes('создана .claude/links/INDEX.md'), out.trim());
  check('docs/links не создан', !fs.existsSync(path.join(dir, 'docs/links')));
}

// Пустая история — своя: чужого автора в ней нет.
{
  const dir = project({ authors: [] });
  const { code, out } = run(SCRIPT, dir);
  check('пустая история → docs/links', code === 0 && out.includes('создана docs/links/INDEX.md'), out.trim());
}

// Плоская карта старого формата — не наращивать вторую, а разбить.
{
  const dir = project({ files: { 'docs/implicit-links.md': '# Связи\n' } });
  const { code, out } = run(SCRIPT, dir);
  check('плоская карта → отказ', code === 1 && out.includes('плоская'), out.trim());
  check('рядом с плоской ничего не создано', !fs.existsSync(path.join(dir, 'docs/links')));
}

process.stdout.write(failed ? `\n${failed} FAIL\n` : '\nвсе тесты init-impact-map зелёные\n');
process.exit(failed ? 1 : 0);
