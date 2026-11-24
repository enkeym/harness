import './env-isolate.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { playwrightEnv } from '../../bin/playwright-env.mjs';

test('Chrome discovery preserves explicit settings and delegates native platforms to Playwright', () => {
  assert.deepEqual(playwrightEnv({}), {});
  assert.deepEqual(playwrightEnv({ WSL_DISTRO_NAME: 'test', PLAYWRIGHT_MCP_EXECUTABLE_PATH: '/custom/chrome' }),
    { PLAYWRIGHT_MCP_EXECUTABLE_PATH: '/custom/chrome' });
});

test('WSL Chrome discovery uses PATH then the current Windows registry without a fixed user or drive', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chrome-discovery-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const chrome = path.join(dir, 'chrome.exe');
  fs.writeFileSync(chrome, '', { mode: 0o700 });
  assert.deepEqual(playwrightEnv({ WSL_DISTRO_NAME: 'test', PATH: dir }), { PLAYWRIGHT_MCP_EXECUTABLE_PATH: chrome });
  const bin = path.join(dir, 'bin'); fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'powershell.exe'), `#!${process.execPath}\nprocess.stdout.write('D:\\\\Users\\\\other\\\\Chrome\\\\chrome.exe');\n`, { mode: 0o700 });
  fs.writeFileSync(path.join(bin, 'wslpath'), `#!${process.execPath}\nif (process.argv[2] !== '-u' || !process.argv[3].startsWith('D:')) process.exit(1); process.stdout.write(process.env.TEST_CHROME);\n`, { mode: 0o700 });
  assert.deepEqual(playwrightEnv({ WSL_DISTRO_NAME: 'test', PATH: bin, TEST_CHROME: chrome }), { PLAYWRIGHT_MCP_EXECUTABLE_PATH: chrome });
  assert.throws(() => playwrightEnv({ WSL_DISTRO_NAME: 'test', PATH: path.join(dir, 'missing') }));
});

function syncProfile(t, wsl = '') {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-wsl-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const bin = path.join(home, 'bin');
  fs.mkdirSync(bin);
  fs.symlinkSync(process.execPath, path.join(bin, 'node'));
  const config = path.join(home, 'config');
  const env = {
    ...process.env,
    HOME: home,
    XDG_CONFIG_HOME: config,
    OPENCODE_CONFIG_DIR: path.join(config, 'opencode'),
    PATH: bin,
    WSL_DISTRO_NAME: wsl,
    PLAYWRIGHT_MCP_EXECUTABLE_PATH: '',
    PLAYWRIGHT_MCP_EXTENSION_TOKEN: '',
  };
  const run = (...args) => spawnSync(process.execPath, [
    path.resolve(import.meta.dirname, '../../bin/mcp-sync.mjs'), ...args,
  ], { env, encoding: 'utf8' });
  return { run, settings: path.join(env.OPENCODE_CONFIG_DIR, 'opencode.jsonc') };
}

test('OpenCode MCP sync registers all servers on WSL without Windows Chrome', t => {
  const { run, settings } = syncProfile(t, 'test');
  const install = run();
  assert.equal(install.status, 0, install.stderr + install.stdout);
  const { mcp } = JSON.parse(fs.readFileSync(settings, 'utf8'));
  assert.deepEqual(Object.keys(mcp.servers).sort(), ['playwright', 'ragsave', 'tokensave']);
  assert.equal(mcp.servers.playwright.environment.PLAYWRIGHT_MCP_EXTENSION_TOKEN, undefined);

  const check = run('--check');
  assert.equal(check.status, 0, check.stderr + check.stdout);
});

test('OpenCode MCP sync preserves an existing environment alias', t => {
  const { run, settings } = syncProfile(t);
  const install = run();
  assert.equal(install.status, 0, install.stderr + install.stdout);
  const { mcp } = JSON.parse(fs.readFileSync(settings, 'utf8'));
  const tokenRef = '{env:MY_PLAYWRIGHT_TOKEN}';
  mcp.servers.playwright.environment.PLAYWRIGHT_MCP_EXTENSION_TOKEN = tokenRef;
  fs.writeFileSync(settings, JSON.stringify({ mcp }));
  const withAlias = run('--check');
  assert.equal(withAlias.status, 0, withAlias.stderr + withAlias.stdout);
});
