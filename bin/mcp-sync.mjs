import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { playwrightEnv } from './playwright-env.mjs';

const HARNESS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SERVERS = path.join(HARNESS, 'mcp', 'servers.json');
const LOCAL_ENV = path.join(HARNESS, '.env.local');
const CHECK = process.argv.includes('--check');

let drift = 0;
const good = (s) => console.log(`  \x1b[32m✓\x1b[0m ${s}`);
const warn = (s) => console.log(`  \x1b[33m!\x1b[0m ${s}`);
const bad = (s) => console.log(`  \x1b[31m✗\x1b[0m ${s}`);

// `~/` в servers.json раскрывается в домашний каталог пользователя.
const expand = (p) => (p.startsWith('~/') ? path.join(os.homedir(), p.slice(2)) : p);

const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));

function readLocalEnv() {
  if (!fs.existsSync(LOCAL_ENV)) return {};
  const mode = fs.statSync(LOCAL_ENV).mode & 0o777;
  if ((mode & 0o077) !== 0) {
    if (CHECK) {
      drift++;
      warn('.env.local — требуются приватные права доступа (600)');
    } else {
      fs.chmodSync(LOCAL_ENV, 0o600);
      warn('.env.local — права доступа ограничены владельцем (600)');
    }
  }

  const env = {};
  const lines = fs.readFileSync(LOCAL_ENV, 'utf8').split(/\r?\n/);
  for (const [index, source] of lines.entries()) {
    const line = source.trim();
    if (!line || line.startsWith('#')) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match) throw new Error(`${LOCAL_ENV}:${index + 1} — ожидается NAME=VALUE`);

    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    } else {
      value = value.replace(/\s+#.*$/, '');
    }
    env[match[1]] = value;
  }
  return env;
}

const localEnv = readLocalEnv();
function serverEnv(name, configuredEnv = {}) {
  const prefix = `${name.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_MCP_`;
  const local = Object.fromEntries(Object.entries(localEnv).filter(([key]) => key.startsWith(prefix)));
  return { ...local, ...configuredEnv };
}

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
  servers[name] = { command, args: (s.args ?? []).map(expand), env: serverEnv(name, s.env ?? {}) };
}
const sameJson = (a, b) => JSON.stringify(a) === JSON.stringify(b);

async function syncCodex() {
  console.log('Codex (config.toml, scope user):');
  const current = JSON.parse(execFileSync('codex', ['mcp', 'list', '--json'], { encoding: 'utf8', cwd: os.homedir() }));
  const edits = [];
  for (const [name, s] of Object.entries(servers)) {
    const have = current.find((entry) => entry.name === name);
    const transport = have?.transport;
    const env = { ...(transport?.env ?? {}), ...s.env };
    if (name === 'playwright') Object.assign(env, playwrightEnv({ ...process.env, ...env }));
    if (transport?.type === 'stdio' && transport.command === s.command
      && sameJson(transport.args ?? [], s.args)
      && sameJson(transport.env ?? {}, env)) {
      good(name);
      continue;
    }
    if (CHECK) {
      warn(`${name} — ${have ? 'отличается от servers.json' : 'не зарегистрирован'}`);
      drift += 1;
      continue;
    }
    if (have) {
      for (const [key, value] of Object.entries({ command: s.command, args: s.args, env, url: null })) {
        edits.push({ keyPath: `mcp_servers.${JSON.stringify(name)}.${key}`, value, mergeStrategy: 'replace' });
      }
      continue;
    }
    const envArgs = Object.entries(env).flatMap(([key, value]) => ['--env', `${key}=${value}`]);
    execFileSync('codex', ['mcp', 'add', name, ...envArgs, '--', s.command, ...s.args], { stdio: 'pipe', cwd: os.homedir() });
    good(`${name} — зарегистрирован`);
  }
  if (edits.length) {
    const { AppServer } = await import('../ai-hooks/bin/context-runner.mjs');
    const client = new AppServer({ cwd: os.homedir(), env: { ...process.env, HARNESS_CONTEXT_GENERATION_FILE: '' } });
    try {
      await client.initialize(10000);
      await client.request('config/batchWrite', { edits }, 10000);
      good('MCP — команды обновлены с сохранением пользовательских опций');
    } finally { client.close(); }
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
      const catalogAt = registered.args.indexOf('--catalog');
      server = { ...registered, args: registered.args.filter((_, index) => index !== catalogAt && index !== catalogAt + 1) };
    }
    const have = current.mcpServers[name];
    server = { ...server, env: { ...(have?.env ?? {}), ...server.env } };
    if (name === 'playwright') Object.assign(server.env, playwrightEnv({ ...process.env, ...server.env }));
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
else await syncCodex();
process.exit(unresolved.size || (CHECK && drift > 0) ? 1 : 0);
