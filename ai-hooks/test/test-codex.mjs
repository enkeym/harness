#!/usr/bin/env node
import './env-isolate.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-home-'));
const fakeBin = path.join(home, 'fake-bin');
const codexHome = path.join(home, 'custom-codex');
fs.mkdirSync(fakeBin);
fs.mkdirSync(codexHome);
fs.mkdirSync(path.join(home, '.rag-mcp/venv/bin'), { recursive: true });
fs.writeFileSync(path.join(home, '.rag-mcp/venv/bin/python'), '');
const customConfig = 'model = "personal-model"\n';
fs.writeFileSync(path.join(codexHome, 'config.toml'), customConfig);
fs.writeFileSync(path.join(codexHome, 'AGENTS.md'), 'my old instructions');
fs.mkdirSync(path.join(home, '.agents/skills/custom'), { recursive: true });
fs.writeFileSync(path.join(home, '.agents/skills/custom/SKILL.md'), 'custom skill');
fs.writeFileSync(path.join(home, '.codex.json'), 'untouched');
fs.writeFileSync(path.join(fakeBin, 'tokensave'), '#!/bin/sh\necho tokensave-test\n', { mode: 0o755 });
fs.symlinkSync(process.execPath, path.join(fakeBin, 'node'));
const stateFile = path.join(home, 'servers.json');
fs.writeFileSync(stateFile, JSON.stringify([{ name: 'custom', enabled: true, transport: { type: 'streamable_http', url: 'https://example.org/mcp' } }]));
fs.writeFileSync(path.join(fakeBin, 'codex'), `#!${process.execPath}
import fs from 'node:fs';
const args = process.argv.slice(2);
if (args[0] === '--version') { console.log('codex-test'); process.exit(0); }
const file = process.env.FAKE_CODEX_STATE;
let servers = JSON.parse(fs.readFileSync(file, 'utf8'));
if (args[1] === 'list') { console.log(JSON.stringify(servers)); process.exit(0); }
const name = args[2];
servers = servers.filter((server) => server.name !== name);
if (args[1] === 'add') {
  const split = args.indexOf('--');
  const env = {};
  for (let i = 3; i < split; i++) if (args[i] === '--env') {
    const value = args[++i]; const at = value.indexOf('='); env[value.slice(0, at)] = value.slice(at + 1);
  }
  servers.push({ name, enabled: true, transport: { type: 'stdio', command: args[split + 1], args: args.slice(split + 2), env } });
}
fs.writeFileSync(file, JSON.stringify(servers));
`, { mode: 0o755 });
const env = { ...process.env, HOME: home, CODEX_HOME: codexHome, RAGSAVE_HOME: path.join(home, '.rag-mcp'), PATH: `${fakeBin}:${process.env.PATH}`, FAKE_CODEX_STATE: stateFile };
delete env.CODEX_SESSION_ID;
const install = (...args) => spawnSync('bash', [path.join(root, 'install.sh'), '--codex', ...args], { env, encoding: 'utf8', timeout: 30000 });
let result = install('--check');
assert.equal(result.status, 1, result.stderr);
assert.equal(fs.existsSync(path.join(codexHome, 'hooks.json')), false, '--check не создаёт файлы');
assert.equal(JSON.parse(fs.readFileSync(stateFile)).length, 1, '--check не регистрирует MCP');
result = install();
assert.equal(result.status, 0, result.stdout + result.stderr);
assert.equal(fs.readFileSync(path.join(codexHome, 'config.toml'), 'utf8'), customConfig);
assert.equal(fs.readFileSync(path.join(home, '.codex.json'), 'utf8'), 'untouched');
assert.equal(fs.readFileSync(path.join(home, '.agents/skills/custom/SKILL.md'), 'utf8'), 'custom skill');
assert.ok(fs.readdirSync(codexHome).some((name) => name.startsWith('AGENTS.md.bak-')));
assert.ok(fs.lstatSync(path.join(codexHome, 'hooks.json')).isSymbolicLink());
assert.deepEqual(JSON.parse(fs.readFileSync(path.join(codexHome, 'hooks.json'), 'utf8')),
  JSON.parse(fs.readFileSync(path.join(root, 'codex/hooks.json'), 'utf8')), 'установщик подключает RAG hooks');
assert.deepEqual(JSON.parse(fs.readFileSync(stateFile)).map((s) => s.name).sort(), ['custom', 'ragsave', 'tokensave']);
const before = fs.readFileSync(stateFile, 'utf8');
result = install('--check');
assert.equal(result.status, 0, result.stdout + result.stderr);
assert.equal(fs.readFileSync(stateFile, 'utf8'), before);
result = install();
assert.equal(result.status, 0, result.stdout + result.stderr);
assert.equal(fs.readFileSync(stateFile, 'utf8'), before, 'повторная установка идемпотентна');
// Если CLI установлен, проверяем реальный TOML round-trip без аккаунта и сети.
const cliEnv = { ...env, PATH: process.env.PATH };
const cli = spawnSync('codex', ['--version'], { env: cliEnv, encoding: 'utf8' });
if (cli.status === 0) {
  for (const args of [[], ['--check']]) {
    const real = spawnSync(process.execPath, [path.join(root, 'bin/mcp-sync.mjs'), '--codex', ...args], { env: cliEnv, encoding: 'utf8', timeout: 30000 });
    assert.equal(real.status, 0, real.stdout + real.stderr);
  }
  const parsed = spawnSync('codex', ['mcp', 'list', '--json'], { env: cliEnv, encoding: 'utf8', timeout: 30000 });
  assert.equal(parsed.status, 0, parsed.stderr);
  assert.deepEqual(JSON.parse(parsed.stdout).map((s) => s.name).sort(), ['ragsave', 'tokensave']);
  assert.ok(fs.readFileSync(path.join(codexHome, 'config.toml'), 'utf8').includes(customConfig.trim()));
  console.log('Codex CLI: real MCP config round-trip passed');
}
console.log('Codex: installer and MCP passed');
