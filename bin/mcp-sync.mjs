import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { playwrightEnv } from './playwright-env.mjs';
import { expandHome } from './home-path.mjs';
import { good, warn, bad } from './report.mjs';
import { resolveCommand } from './command-path.mjs';

const HARNESS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SERVERS = path.join(HARNESS, 'mcp', 'servers.json');
const LOCAL_ENV = path.join(HARNESS, '.env.local');
const CHECK = process.argv.includes('--check');
const args = process.argv.slice(2);
if (args.some(arg => arg !== '--check')) {
  console.error('Использование: node bin/mcp-sync.mjs [--check]');
  process.exit(2);
}

let drift = 0;


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

const servers = {};
const unresolved = new Set();
for (const [name, s] of Object.entries(readJson(SERVERS))) {
  const command = resolveCommand(s.command);
  if (!command) {
    bad(`${name} — команда ${s.command} не найдена в PATH, сервер пропущен`);
    unresolved.add(name);
    continue;
  }
  servers[name] = { command, args: (s.args ?? []).map(expandHome), env: serverEnv(name, s.env ?? {}) };
}
const sameJson = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const opencodeEnvironment = (name, environment) => {
  const source = { ...process.env, ...environment };
  const discovered = name === 'playwright' ? playwrightEnv(source) : {};
  const keys = new Set([...Object.keys(environment), ...Object.keys(discovered)]);
  if (name === 'playwright' && source.PLAYWRIGHT_MCP_EXTENSION_TOKEN) keys.add('PLAYWRIGHT_MCP_EXTENSION_TOKEN');
  return Object.fromEntries([...keys].map((key) => [key, `{env:${key}}`]));
};

async function syncOpenCode() {
  const { loadConfig, writeConfig } = await import('../opencode/config.mjs');
  const { settings, current } = loadConfig();
  current.mcp ??= {};
  current.mcp.servers ??= {};
  let changed = false;
  for (const [name, server] of Object.entries(servers)) {
    const have = current.mcp.servers[name];
    const environment = opencodeEnvironment(name, { ...(have?.environment ?? {}), ...server.env });
    const command = [server.command, ...server.args];
    const desired = { ...have, type: 'local', command, environment };
    delete desired.url;
    if (sameJson(have, desired)) { good(name); continue; }
    drift++;
    if (CHECK) { warn(`${name} — требуется синхронизация OpenCode`); continue; }
    current.mcp.servers[name] = desired;
    changed = true;
    good(`${name} — зарегистрирован в OpenCode`);
  }
  if (changed) {
    writeConfig(settings, current);
  }
}

await syncOpenCode();
process.exit(unresolved.size || (CHECK && drift > 0) ? 1 : 0);
