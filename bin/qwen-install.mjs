#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const home = os.homedir();
const qwenHome = process.env.QWEN_HOME || path.join(home, '.qwen');
const args = process.argv.slice(2);
if (args.some(arg => !['--check', '--yes'].includes(arg))) {
  console.error('Использование: ./install.sh --qwen [--check] [--yes]');
  process.exit(2);
}
const check = args.includes('--check');
let drift = 0;
const links = [
  [path.join(qwenHome, 'QWEN.md'), 'qwen/QWEN.md'],
  [path.join(home, '.ai-hooks'), 'ai-hooks'],
  [path.join(home, '.config/harness/repo'), '.'],
  [path.join(home, '.tokensave/config.toml'), 'tokensave/config.toml'],
  [path.join(home, '.local/bin/ragsave'), 'bin/ragsave'],
  ...fs.readdirSync(path.join(root, 'skills'))
    .filter(name => name === 'shared' || fs.existsSync(path.join(root, 'skills', name, 'SKILL.md')))
    .map(name => [path.join(qwenHome, 'skills', name), `skills/${name}`]),
];
for (const [target, relative] of links) {
  const source = path.resolve(root, relative);
  let stat;
  try { stat = fs.lstatSync(target); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (stat?.isSymbolicLink() && path.resolve(path.dirname(target), fs.readlinkSync(target)) === source && fs.existsSync(source)) continue;
  if (check) { console.error(`✗ ${target}`); drift++; continue; }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  if (stat) fs.renameSync(target, `${target}.bak-${Date.now()}`);
  fs.symlinkSync(source, target);
  console.log(`✓ ${target}`);
}

// Merge only harness-owned hooks; retain user hooks and authentication settings.
const settings = path.join(qwenHome, 'settings.json');
const current = fs.existsSync(settings) ? JSON.parse(fs.readFileSync(settings, 'utf8')) : {};
current.hooks ??= {};
let changed = false;
for (const event of ['SessionStart', 'Stop']) {
  const entries = current.hooks[event] ?? [];
  for (const script of ['ragsave-sync.sh', 'tokensave-sync.sh']) {
    const command = `bash "$HOME/.ai-hooks/bin/${script}" ${script === 'ragsave-sync.sh' && event === 'SessionStart' ? '--warm ' : ''}"$QWEN_PROJECT_DIR"`;
    const existing = entries.flatMap(entry => entry.hooks ?? []).filter(hook => hook.command === command);
    if (existing.length && existing.every(hook => hook.timeout === 10000)) continue;
    if (check) { console.error(`✗ Qwen ${event} ${script} hook`); drift++; continue; }
    if (existing.length) existing.forEach(hook => { hook.timeout = 10000; });
    else entries.push({ hooks: [{ type: 'command', command, timeout: 10000 }] });
    current.hooks[event] = entries;
    changed = true;
  }
}
if (changed) {
  fs.mkdirSync(qwenHome, { recursive: true });
  if (fs.existsSync(settings)) fs.copyFileSync(settings, `${settings}.bak-${Date.now()}`, fs.constants.COPYFILE_EXCL);
  fs.writeFileSync(settings, `${JSON.stringify(current, null, 2)}\n`, { mode: 0o600 });
}
try {
  execFileSync(process.execPath, [path.join(root, 'bin/mcp-sync.mjs'), '--qwen', ...(check ? ['--check'] : [])], { stdio: 'inherit' });
  execFileSync('qwen', ['--version'], { stdio: 'inherit' });
} catch { drift++; }
process.exitCode = drift ? 1 : 0;
