import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HARNESS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SERVERS = path.join(HARNESS, 'mcp', 'servers.json');
const CHECK = process.argv.includes('--check');

let drift = 0;
const good = (s) => console.log(`  \x1b[32m✓\x1b[0m ${s}`);
const warn = (s) => console.log(`  \x1b[33m!\x1b[0m ${s}`);
const bad = (s) => console.log(`  \x1b[31m✗\x1b[0m ${s}`);

// `~/` в servers.json раскрывается в домашний каталог пользователя.
const expand = (p) => (p.startsWith('~/') ? path.join(os.homedir(), p.slice(2)) : p);

const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));

// Голое имя ищется по PATH; --check замечает смену пути, например после nvm.
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
  servers[name] = { command, args: s.args ?? [], env: s.env ?? {} };
}
const sameJson = (a, b) => JSON.stringify(a) === JSON.stringify(b);

function syncCodex() {
  console.log('Codex (config.toml, scope user):');
  const current = JSON.parse(execFileSync('codex', ['mcp', 'list', '--json'], { encoding: 'utf8', cwd: os.homedir() }));
  for (const [name, s] of Object.entries(servers)) {
    const have = current.find((entry) => entry.name === name);
    const transport = have?.transport;
    if (have?.enabled !== false && transport?.type === 'stdio' && transport.command === s.command
      && sameJson(transport.args ?? [], s.args)
      && sameJson(transport.env ?? {}, s.env)) {
      good(name);
      continue;
    }
    if (CHECK) {
      warn(`${name} — ${have ? 'отличается от servers.json' : 'не зарегистрирован'}`);
      drift += 1;
      continue;
    }
    const envArgs = Object.entries(s.env).flatMap(([key, value]) => ['--env', `${key}=${value}`]);
    if (have) execFileSync('codex', ['mcp', 'remove', name], { stdio: 'pipe', cwd: os.homedir() });
    execFileSync('codex', ['mcp', 'add', name, ...envArgs, '--', s.command, ...s.args], { stdio: 'pipe', cwd: os.homedir() });
    good(`${name} — зарегистрирован`);
  }
}

syncCodex();
process.exit(unresolved.size || (CHECK && drift > 0) ? 1 : 0);
