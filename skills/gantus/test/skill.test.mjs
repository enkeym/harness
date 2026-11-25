import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const skill = path.resolve(import.meta.dirname, '..');
const root = path.resolve(skill, '../..');

function read(relative) {
  return fs.readFileSync(path.join(skill, relative), 'utf8');
}

test('the skill declares one catalog id and a single-line description', () => {
  const text = read('SKILL.md');
  const match = /^---\n([\s\S]*?)\n---\n/.exec(text);
  assert.ok(match);
  const name = /^name:\s*(.+)$/m.exec(match[1])?.[1]?.trim();
  const description = /^description:\s*(.+)$/m.exec(match[1])?.[1]?.trim();
  assert.equal(name, 'gantus');
  assert.ok(description);
  assert.equal(/^[|>]$/.test(description), false);
});

test('commands, variables, disable and removal are documented', () => {
  const skillText = read('SKILL.md');
  const reference = read('reference/workflow.md');
  const example = read('.env.example');
  for (const command of ['get', 'create', 'edit', 'comment', 'move', 'review-ready', 'rename-branch']) {
    assert.match(reference, new RegExp(`\\b${command}\\b`));
  }
  for (const name of [
    'GANTUS_BASE_URL', 'GANTUS_TEAM_ID', 'GANTUS_SESSION_COOKIE',
    'GANTUS_USER_ID', 'GANTUS_GIT_REMOTE'
  ]) {
    assert.match(reference, new RegExp(name));
    assert.match(example, new RegExp(`^${name}=`, 'm'));
  }
  assert.match(skillText, /delete\s+`skills\/gantus\/`/i);
  assert.match(reference, /Disable and remove/);
});

test('configuration adds named assignments without replacing the shared env file', () => {
  const reference = read('reference/workflow.md');
  assert.doesNotMatch(reference, /Copy `\.\.\/\.env\.example` there/);
  assert.match(reference, /append them\s+to `~\/\.config\/harness\/env`/);
  assert.match(reference, /without replacing that\s+shared file/);
});

test('the CLI runs through an installed skill symlink', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gantus-link-'));
  const link = path.join(home, 'gantus');
  fs.symlinkSync(skill, link);
  const result = spawnSync(process.execPath, [path.join(link, 'scripts/gantus.mjs'), 'get', '--key', 'STR-1'], {
    encoding: 'utf8',
    timeout: 10000,
    env: { PATH: process.env.PATH, HOME: home }
  });
  fs.rmSync(home, { recursive: true, force: true });

  assert.equal(result.status, 2);
  assert.match(result.stderr, /GANTUS_BASE_URL/);
});

test('both entry points gate on the catalog, exact id and installed base path', () => {
  const mr = fs.readFileSync(path.join(root, 'skills/git-flow/reference/mr.md'), 'utf8');
  const review = fs.readFileSync(path.join(root, 'skills/review/SKILL.md'), 'utf8');
  for (const text of [mr, review]) {
    assert.match(text, /active skill catalog/);
    assert.match(text, /load it by exact id/);
    assert.match(text, /<gantus-base>\/scripts\/gantus\.mjs/);
    assert.match(text, /unchanged cwd/);
    assert.doesNotMatch(text, /from\s+`skills\/gantus`/);
  }
  assert.match(mr, /MR \*\*create\*\* POST/);
  assert.match(mr, /never for PUT\/update, draft, dry run or failure/);
  assert.match(mr, /`source_branch`/);
  assert.match(mr, /not from the title/);
  assert.match(mr, /reuse the same POST stdout/);
  assert.match(mr, /no second MR request/);
  assert.match(mr, /review-ready --key <STR> --mr <json>/);
  assert.match(review, /get\s+--key <STR>/);
  assert.match(review, /read-only\s+context/);
  assert.match(review, /Never fetch it implicitly, copy task data/);
});
