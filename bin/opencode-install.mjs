import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { isDeepStrictEqual } from 'node:util';
import { installShell } from './shell-install.mjs';
import { configDirectory, loadConfig, writeConfig } from '../opencode/config.mjs';
import { importQwen } from '../opencode/qwen-import.mjs';
import { contextPolicy, handoffCommand } from '../ai-hooks/bin/context-policy.mjs';

const root = path.resolve(import.meta.dirname, '..');
const home = os.homedir();
const directory = configDirectory();
const args = process.argv.slice(2);
if (args.some(arg => !['--check', '--yes', '--import-qwen'].includes(arg))) {
  console.error('Использование: ./install.sh --opencode [--check] [--yes] [--import-qwen]');
  process.exit(2);
}
const check = args.includes('--check');
const { settings, current } = loadConfig(directory);
const desired = args.includes('--import-qwen') ? importQwen(current, directory, check) : structuredClone(current);
desired.instructions = [...new Set([...(current.instructions ?? []), path.join(root, 'opencode/AGENTS.md'), path.join(root, 'rules/core.md')])];
desired.commands = { ...current.commands, handoff: { description: 'Save Handoff and the remaining plan', template: handoffCommand } };
desired.compaction = { ...current.compaction, auto: true, keep: { tokens: contextPolicy.keepTokens }, buffer: contextPolicy.maxTokens - contextPolicy.startTokens };
desired.plugins = (current.plugins ?? []).filter(plugin => plugin !== new URL('../opencode/harness.mjs', import.meta.url).href);
let drift = 0;
if (!isDeepStrictEqual(current, desired) || !fs.existsSync(settings)) {
  if (check) { console.error('✗ OpenCode instructions/plugins'); drift++; }
  else {
    writeConfig(settings, desired);
  }
}
const links = [
  [path.join(directory, 'plugins/harness.js'), 'opencode/harness.js'],
  [path.join(directory, 'agents/ask.md'), 'opencode/agent/ask.md'],
  [path.join(home, '.ai-hooks'), 'ai-hooks'],
  [path.join(home, '.config/harness/repo'), '.'],
  [path.join(home, '.config/harness/bashrc'), 'shell/harness.bash'],
  [path.join(home, '.tokensave/config.toml'), 'tokensave/config.toml'],
  [path.join(home, '.local/bin/ragsave'), 'bin/ragsave'],
  ...fs.readdirSync(path.join(root, 'skills'))
    .filter(name => name === 'shared' || fs.existsSync(path.join(root, 'skills', name, 'SKILL.md')))
    .map(name => [path.join(directory, 'skills', name), `skills/${name}`]),
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
}
drift += installShell(home, check);
try {
  execFileSync(process.execPath, [path.join(root, 'bin/mcp-sync.mjs'), '--opencode', ...(check ? ['--check'] : [])], { stdio: 'inherit' });
  execFileSync('opencode', ['--version'], { stdio: 'inherit' });
} catch { drift++; }
process.exitCode = drift ? 1 : 0;
