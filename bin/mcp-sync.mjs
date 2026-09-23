#!/usr/bin/env node
// Единый список MCP-серверов (mcp/servers.json) → Claude Code и OpenCode.
//
// Claude держит серверы в ~/.claude.json вперемешку с историей проектов, файл
// в репозиторий не кладётся — туда пишем через `claude mcp add-json`.
// OpenCode читает блок `mcp` из opencode/opencode.json — его переписываем здесь,
// остальные поля файла не трогаем.
//
//   node bin/mcp-sync.mjs          привести оба агента к servers.json
//   node bin/mcp-sync.mjs --check  только отчёт; код выхода 1 при расхождении
//
// Серверы, которых нет в servers.json, не удаляются — только предупреждение:
// их мог добавить проектный конфиг или ручной эксперимент.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HARNESS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SERVERS = path.join(HARNESS, 'mcp', 'servers.json');
const OPENCODE = path.join(HARNESS, 'opencode', 'opencode.json');
const CLAUDE_JSON = path.join(os.homedir(), '.claude.json');
const CHECK = process.argv.includes('--check');

let drift = 0;
const good = (s) => console.log(`  \x1b[32m✓\x1b[0m ${s}`);
const warn = (s) => console.log(`  \x1b[33m!\x1b[0m ${s}`);
const bad = (s) => console.log(`  \x1b[31m✗\x1b[0m ${s}`);

// `~/` в servers.json — чтобы список не зависел от имени пользователя; в
// ~/.claude.json уходит уже абсолютный путь.
const expand = (p) => (p.startsWith('~/') ? path.join(os.homedir(), p.slice(2)) : p);

// opencode.json лежит в репозитории, поэтому машинных путей в нём нет: `~/`
// → `{env:HOME}/` (OpenCode подставляет переменные в текст конфига), голое имя
// остаётся как есть — OpenCode запускают из оболочки, где PATH уже с nvm.
const forOpencode = (cmd) => (cmd.startsWith('~/') ? `{env:HOME}/${cmd.slice(2)}` : cmd);

const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));

// Голое имя (`playwright-mcp`) ищется по PATH того, кто запускает синк, и в
// Claude уходит найденный путь: так в servers.json не зашита версия node из
// nvm, а после смены версии --check видит устаревший путь как расхождение.
// Не нашлось — null: писать агентам команду, которая не стартует, нельзя.
function resolveCommand(cmd) {
  if (cmd.includes('/')) return expand(cmd);
  for (const dir of (process.env.PATH || '').split(path.delimiter).filter(Boolean)) {
    const file = path.join(dir, cmd);
    try {
      fs.accessSync(file, fs.constants.X_OK);
      if (fs.statSync(file).isFile()) return file;
    } catch { /* нет в этом каталоге */ }
  }
  return null;
}

const servers = {};
const unresolved = new Set();
for (const [name, s] of Object.entries(readJson(SERVERS))) {
  const command = resolveCommand(s.command);
  if (!command) {
    bad(`${name} — команда ${s.command} не найдена в PATH, сервер пропущен`);
    unresolved.add(name);
    continue;
  }
  servers[name] = { command, opencodeCommand: forOpencode(s.command), args: s.args ?? [], env: s.env ?? {} };
}
const listed = (name) => name in servers || unresolved.has(name);

const sameJson = (a, b) => JSON.stringify(a) === JSON.stringify(b);

function syncOpencode() {
  console.log('OpenCode (opencode/opencode.json):');
  const config = readJson(OPENCODE);
  const current = config.mcp ?? {};

  const wanted = Object.fromEntries(
    Object.entries(servers).map(([name, s]) => [
      name,
      {
        type: 'local',
        command: [s.opencodeCommand, ...s.args],
        ...(Object.keys(s.env).length ? { environment: s.env } : {}),
      },
    ]),
  );

  for (const name of Object.keys(current)) {
    if (!listed(name)) warn(`${name} — есть в opencode.json, нет в servers.json`);
  }

  const stale = Object.keys(wanted).filter((name) => !sameJson(current[name], wanted[name]));
  if (!stale.length) {
    good(`совпадает: ${Object.keys(wanted).join(', ')}`);
    return;
  }

  if (CHECK) {
    for (const name of stale) warn(`${name} — отличается от servers.json`);
    drift += stale.length;
    return;
  }

  const extra = Object.fromEntries(Object.entries(current).filter(([name]) => !(name in wanted)));
  // Порядок ключей сохраняется: mcp остаётся на своём месте в файле.
  config.mcp = { ...wanted, ...extra };
  fs.writeFileSync(OPENCODE, `${JSON.stringify(config, null, 2)}\n`);
  for (const name of stale) good(`${name} — обновлён`);
}

function syncClaude() {
  console.log('Claude Code (~/.claude.json, scope user):');
  if (!fs.existsSync(CLAUDE_JSON)) {
    bad('~/.claude.json нет — сначала запустить и залогинить claude');
    drift += 1;
    return;
  }
  const current = readJson(CLAUDE_JSON).mcpServers ?? {};

  for (const name of Object.keys(current)) {
    if (!listed(name)) warn(`${name} — зарегистрирован в Claude, нет в servers.json`);
  }

  for (const [name, s] of Object.entries(servers)) {
    const have = current[name];
    const matches =
      have &&
      have.command === s.command &&
      sameJson(have.args ?? [], s.args) &&
      sameJson(have.env ?? {}, s.env);
    if (matches) {
      good(name);
      continue;
    }
    if (CHECK) {
      warn(`${name} — ${have ? 'отличается от servers.json' : 'не зарегистрирован'}`);
      drift += 1;
      continue;
    }
    if (have) execFileSync('claude', ['mcp', 'remove', '-s', 'user', name], { stdio: 'ignore' });
    const spec = { type: 'stdio', command: s.command, args: s.args, env: s.env };
    execFileSync('claude', ['mcp', 'add-json', '-s', 'user', name, JSON.stringify(spec)], {
      stdio: 'ignore',
    });
    good(`${name} — ${have ? 'перерегистрирован' : 'зарегистрирован'}`);
  }
}

syncOpencode();
syncClaude();
// Ненайденная команда — ошибка и при синке: сервер у агентов не обновлён.
process.exit(unresolved.size || (CHECK && drift > 0) ? 1 : 0);
