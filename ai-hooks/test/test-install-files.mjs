import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { installShell } from '../../bin/shell-install.mjs';
import { installInstructions, installHooks, installDefaults, installLink } from '../../bin/install-files.mjs';

function sandbox(t) {
  t.mock.method(console, 'error', () => {});
  t.mock.method(console, 'log', () => {});
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-install-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  return home;
}

test('bash bootstrap moves ahead of early return without duplicates or losing user bytes', t => {
  const home = sandbox(t);
  const file = path.join(home, '.bashrc');
  const bootstrap = '[ -f "$HOME/.config/harness/bashrc" ] && . "$HOME/.config/harness/bashrc"\n';
  const user = 'case $- in *i*) ;; *) return;; esac\nexport PERSONAL=value\n';
  fs.writeFileSync(file, user + bootstrap + bootstrap);

  assert.equal(installShell(home, true, { SHELL: '/bin/bash' }), 1);
  assert.equal(fs.readFileSync(file, 'utf8'), user + bootstrap + bootstrap);
  installShell(home, false, { SHELL: '/bin/bash' });
  assert.equal(fs.readFileSync(file, 'utf8'), bootstrap + user);
  const names = fs.readdirSync(home);
  installShell(home, false, { SHELL: '/bin/bash' });
  assert.deepEqual(fs.readdirSync(home), names);
});

test('zsh uses ZDOTDIR and does not create bash startup files', t => {
  const home = sandbox(t);
  const dotdir = path.join(home, 'zsh config');
  fs.mkdirSync(dotdir);
  fs.writeFileSync(path.join(dotdir, '.zshenv'), 'export PERSONAL=value\n');
  const env = { SHELL: '/bin/zsh', ZDOTDIR: dotdir };

  installShell(home, false, env);
  const text = fs.readFileSync(path.join(dotdir, '.zshenv'), 'utf8');
  assert.ok(text.endsWith('export PERSONAL=value\n'));
  assert.equal(fs.existsSync(path.join(home, '.bashrc')), false);
  assert.equal(installShell(home, true, env), 0);
});

test('unsupported shell fails without creating unrelated startup files', t => {
  const home = sandbox(t);
  assert.equal(installShell(home, false, { SHELL: '/bin/fish' }), 1);
  assert.deepEqual(fs.readdirSync(home), []);
});

test('instructions preserve active user rules and update only their managed section', t => {
  const home = sandbox(t);
  const target = path.join(home, 'AGENTS.md');
  const source = path.join(home, 'source.md');
  fs.writeFileSync(target, 'Personal rules\n');
  fs.writeFileSync(source, 'Harness rules\n');

  assert.equal(installInstructions(target, source, true), 1);
  assert.equal(fs.readFileSync(target, 'utf8'), 'Personal rules\n');
  installInstructions(target, source, false);
  fs.writeFileSync(source, 'Updated harness rules\n');
  installInstructions(target, source, false);
  const text = fs.readFileSync(target, 'utf8');
  assert.ok(text.startsWith('Personal rules\n'));
  assert.ok(text.includes('Updated harness rules'));
  assert.ok(!text.includes('\nHarness rules\n'));
  assert.equal(installInstructions(target, source, true), 0);
});

test('hooks preserve user handlers and settings through repeated updates', t => {
  const home = sandbox(t);
  const target = path.join(home, 'hooks.json');
  const source = path.join(home, 'source.json');
  const personal = { matcher: 'startup', hooks: [{ type: 'command', command: 'personal-start' }] };
  const managed = { hooks: [{ type: 'command', command: 'node "$HOME/.ai-hooks/bin/skill-context.mjs"', timeout: 10 }] };
  fs.writeFileSync(target, JSON.stringify({ custom: true, hooks: { SessionStart: [personal], Other: [] } }));
  fs.writeFileSync(source, JSON.stringify({ hooks: { SessionStart: [managed] } }));

  installHooks(target, source, false);
  installHooks(target, source, false);
  const saved = JSON.parse(fs.readFileSync(target));
  assert.equal(saved.custom, true);
  assert.deepEqual(saved.hooks.SessionStart, [personal, managed]);
  assert.deepEqual(saved.hooks.Other, []);
  assert.equal(installHooks(target, source, true), 0);
  fs.writeFileSync(target, '{bad json');
  assert.throws(() => installHooks(target, source, false));
  assert.equal(fs.readFileSync(target, 'utf8'), '{bad json');
});

test('hooks replace managed commands and check detects updates without writing', t => {
  const home = sandbox(t);
  const target = path.join(home, 'hooks.json');
  const source = path.join(home, 'source.json');
  const personal = { type: 'command', command: 'personal-stop' };
  const oldHook = { type: 'command', command: 'old-command' };
  const newGroup = { hooks: [{ type: 'command', command: 'new-command' }] };
  fs.writeFileSync(source, JSON.stringify({ hooks: { Stop: [{ hooks: [oldHook] }] } }));
  installHooks(target, source, false);
  fs.writeFileSync(target, JSON.stringify({ custom: true, hooks: { Stop: [{ hooks: [personal, oldHook] }] } }));
  fs.writeFileSync(source, JSON.stringify({ hooks: { Stop: [newGroup] } }));
  const before = fs.readFileSync(target, 'utf8');
  const names = fs.readdirSync(home);

  assert.equal(installHooks(target, source, true), 1);
  assert.equal(fs.readFileSync(target, 'utf8'), before);
  assert.deepEqual(fs.readdirSync(home), names);
  installHooks(target, source, false);

  assert.deepEqual(JSON.parse(fs.readFileSync(target)), { custom: true, hooks: { Stop: [{ hooks: [personal] }, newGroup] } });
  assert.equal(installHooks(target, source, true), 0);
  const installedNames = fs.readdirSync(home);
  installHooks(target, source, false);
  assert.deepEqual(fs.readdirSync(home), installedNames);
});

test('hooks remove deleted managed events while preserving personal events', t => {
  const home = sandbox(t);
  const target = path.join(home, 'hooks.json');
  const source = path.join(home, 'source.json');
  const personal = { matcher: 'personal', hooks: [{ type: 'command', command: 'personal-start' }] };
  const managed = { hooks: [{ type: 'command', command: 'managed-stop' }] };
  fs.writeFileSync(target, JSON.stringify({ hooks: { SessionStart: [personal], Other: [] } }));
  fs.writeFileSync(source, JSON.stringify({ hooks: { Stop: [managed] } }));
  installHooks(target, source, false);
  fs.writeFileSync(source, JSON.stringify({ hooks: {} }));

  assert.equal(installHooks(target, source, true), 1);
  installHooks(target, source, false);

  assert.deepEqual(JSON.parse(fs.readFileSync(target)).hooks, { SessionStart: [personal], Other: [] });
  assert.equal(installHooks(target, source, true), 0);
});

test('defaults preserve personal configuration and bootstrap missing files only', t => {
  const home = sandbox(t);
  const target = path.join(home, 'config.toml');
  const source = path.join(home, 'source.toml');
  fs.writeFileSync(source, 'upload_enabled = false\n');
  assert.equal(installDefaults(target, source, true), 1);
  assert.equal(fs.existsSync(target), false);
  installDefaults(target, source, false);
  fs.writeFileSync(target, 'upload_enabled = true\ncustom = "personal"\n');
  installDefaults(target, source, false);
  assert.equal(fs.readFileSync(target, 'utf8'), 'upload_enabled = true\ncustom = "personal"\n');
});

test('dangling configuration and shell links do not create their missing referents', t => {
  const home = sandbox(t);
  const missing = path.join(home, 'missing');
  const source = path.join(home, 'source');
  const config = path.join(home, 'config.toml');
  fs.writeFileSync(source, 'defaults');
  fs.symlinkSync(missing, config);
  fs.symlinkSync(missing, path.join(home, '.bashrc'));

  assert.throws(() => installDefaults(config, source, false), /Dangling/);
  assert.throws(() => installShell(home, false, { SHELL: '/bin/bash' }), /Dangling/);
  assert.equal(fs.existsSync(missing), false);
  assert.equal(fs.readlinkSync(config), missing);
});

test('link conflicts preserve active user directories, files and dangling links', t => {
  const home = sandbox(t);
  const source = path.join(home, 'source');
  fs.mkdirSync(source);
  for (const name of ['directory', 'file', 'link']) {
    const target = path.join(home, name);
    if (name === 'directory') fs.mkdirSync(target);
    else if (name === 'file') fs.writeFileSync(target, 'personal');
    else fs.symlinkSync(path.join(home, 'missing'), target);
    assert.equal(installLink(target, source, false), 1);
    if (name === 'directory') assert.ok(fs.lstatSync(target).isDirectory());
    else if (name === 'file') assert.equal(fs.readFileSync(target, 'utf8'), 'personal');
    else assert.equal(fs.readlinkSync(target), path.join(home, 'missing'));
  }
  const target = path.join(home, 'managed');
  assert.equal(installLink(target, source, true), 1);
  assert.equal(fs.existsSync(target), false);
  assert.equal(installLink(target, source, false), 0);
  assert.equal(installLink(target, source, true), 0);
});

test('macOS bash updates the selected login profile and preserves user shell settings', t => {
  const home = sandbox(t);
  const target = path.join(home, '.bash_login');
  fs.writeFileSync(target, 'export PERSONAL=mac\n');
  const env = { SHELL: '/bin/bash' };

  assert.equal(installShell(home, false, env, 'darwin'), 0);
  assert.ok(fs.readFileSync(target, 'utf8').endsWith('export PERSONAL=mac\n'));
  assert.equal(fs.existsSync(path.join(home, '.bash_profile')), false);
  assert.equal(fs.existsSync(path.join(home, '.zshenv')), false);
  assert.equal(installShell(home, true, env, 'darwin'), 0);
});
