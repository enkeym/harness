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
  servers[name] = { command, args: (s.args ?? []).map(expand), env: s.env ?? {} };
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

function syncQwen() {
  const settings = path.join(process.env.QWEN_HOME || path.join(os.homedir(), '.qwen'), 'settings.json');
  const current = fs.existsSync(settings) ? readJson(settings) : {};
  current.mcpServers ??= {};
  let changed = false;
  for (const [name, registered] of Object.entries(servers)) {
    let server = registered;
    // Qwen probes prompts/resources during discovery, so a catalog proxy is
    // not lazy here and can negotiate a different protocol than its snapshot.
    const separator = registered.args.indexOf('--');
    if (registered.args.includes('--catalog') && registered.args.some(arg => path.basename(arg) === 'mcp-proxy.mjs')
      && separator >= 0 && registered.args[separator + 1]) {
      const command = resolveCommand(registered.args[separator + 1]);
      if (!command) { bad(`${name} — backend не найден`); unresolved.add(name); continue; }
      server = { ...registered, command, args: registered.args.slice(separator + 2) };
    }
    const have = current.mcpServers[name];
    if (have?.command === server.command && sameJson(have.args ?? [], server.args)
      && sameJson(have.env ?? {}, server.env) && !have.url && !have.httpUrl) {
      good(name);
      continue;
    }
    drift++;
    if (CHECK) { warn(`${name} — требуется синхронизация Qwen`); continue; }
    // Preserve trust, timeouts and other Qwen-specific server options.
    const { url, httpUrl, ...options } = have ?? {};
    current.mcpServers[name] = { ...options, ...server };
    changed = true;
    good(`${name} — зарегистрирован в Qwen`);
  }
  if (changed) {
    fs.mkdirSync(path.dirname(settings), { recursive: true });
    if (fs.existsSync(settings)) fs.copyFileSync(settings, `${settings}.bak-${Date.now()}`, fs.constants.COPYFILE_EXCL);
    fs.writeFileSync(settings, `${JSON.stringify(current, null, 2)}\n`, { mode: 0o600 });
  }
}

if (process.argv.includes('--qwen')) syncQwen();
else syncCodex();
process.exit(unresolved.size || (CHECK && drift > 0) ? 1 : 0);
