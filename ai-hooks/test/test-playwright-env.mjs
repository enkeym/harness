import './env-isolate.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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
