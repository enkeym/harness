#!/usr/bin/env node
// Отдельный путь установки Codex: config.toml принадлежит CLI, не симлинкуется.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const home = os.homedir();
const codexHome = process.env.CODEX_HOME || path.join(home, '.codex');
const ragHome = process.env.RAGSAVE_HOME || path.join(home, '.rag-mcp');
const args = process.argv.slice(2);
const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 22 || (major === 22 && minor < 13) || (major === 23 && minor < 4)) {
  console.error('Harness требует Node 22.13+, 23.4+ или 24+.');
  process.exit(1);
}
if (args.some((arg) => !['--check', '--yes', '--venv'].includes(arg))) {
  console.error('Использование: ./install.sh --codex [--check|--venv] [--yes]');
  process.exit(2);
}
if (args.includes('--venv')) {
  if (args.includes('--check')) {
    console.error('--check и --venv нельзя сочетать');
    process.exit(2);
  }
  execFileSync('bash', [path.join(root, 'bin/ragsave-venv.sh')], { stdio: 'inherit' });
  process.exit(0);
}
const check = args.includes('--check');
let drift = 0;
try {
  execFileSync(process.execPath, [path.join(root, 'bin/harness-index-config.mjs'), ...(check ? ['--check'] : [])], { stdio: 'inherit' });
} catch {
  drift++;
}
const links = [
  [path.join(codexHome, 'AGENTS.md'), 'codex/AGENTS.md'],
  [path.join(codexHome, 'hooks.json'), 'codex/hooks.json'],
  [path.join(home, '.ai-hooks'), 'ai-hooks'],
  [path.join(home, '.config/harness/repo'), '.'],
  [path.join(home, '.tokensave/config.toml'), 'tokensave/config.toml'],
  [path.join(home, '.local/bin/ragsave'), 'bin/ragsave'],
  [path.join(home, '.local/bin/harness-context'), 'ai-hooks/bin/context-runner.mjs'],
  ...['ragsave', 'tests', 'README.md'].map((name) => [path.join(ragHome, name), `ragsave/${name}`]),
];
for (const name of fs.readdirSync(path.join(root, 'skills'))) {
  if (name !== 'shared' && !fs.existsSync(path.join(root, 'skills', name, 'SKILL.md'))) continue;
  links.push([path.join(home, '.agents/skills', name), `skills/${name}`]);
}

for (const [target, relative] of links) {
  const source = path.resolve(root, relative);
  let stat;
  try { stat = fs.lstatSync(target); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (stat?.isSymbolicLink() && path.resolve(path.dirname(target), fs.readlinkSync(target)) === source) {
    console.log(`✓ ${target}`);
    continue;
  }
  if (check) {
    console.error(`✗ ${target} — требуется установка`);
    drift++;
    continue;
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  if (stat) {
    const backup = `${target}.bak-${Date.now()}`;
    fs.renameSync(target, backup);
    console.log(`Бэкап: ${backup}`);
  }
  fs.symlinkSync(source, target);
  console.log(`✓ ${target} → ${source}`);
}

for (const command of ['node', 'codex', 'tokensave']) {
  try {
    const version = execFileSync(command, ['--version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    console.log(`✓ ${version.trim()}`);
  } catch {
    console.error(`✗ ${command} не найден или не запускается`);
    drift++;
  }
}
try {
  execFileSync(process.execPath, [path.join(root, 'bin/mcp-sync.mjs'), '--codex', ...(check ? ['--check'] : [])], { stdio: 'inherit', cwd: home });
} catch {
  console.error('✗ MCP Codex: регистрация или проверка не прошла');
  drift++;
}
if (!fs.existsSync(path.join(ragHome, 'venv/bin/python'))) {
  console.error('✗ Нет venv ragsave: ./install.sh --codex --venv');
  drift++;
}
console.log('Фоновые RAG hooks настроены; поисковый guard не подключается. --check не проверяет доверие или исполнение hooks.');
process.exitCode = drift ? 1 : 0;
