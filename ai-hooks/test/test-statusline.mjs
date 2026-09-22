#!/usr/bin/env node
// Тесты статусной строки (claude/statusline.mjs): каталог сокращается до ~,
// ветка видна только в репозитории, цвет модели — по тем-классу, ctx — в
// токенах с цветом порогов context-meter, ask mode читается по корню сессии,
// а не по текущему каталогу, и показывается всегда — даже при битом stdin.

import './env-isolate.mjs';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const STATUSLINE = path.join(ROOT, 'claude', 'statusline.mjs');
const ASK_MODE = path.join(ROOT, 'bin', 'ask-mode.mjs');

let failed = 0;
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  process.stdout.write(`${ok ? 'ok  ' : 'FAIL'} ${name} (got=${JSON.stringify(got)}, want=${JSON.stringify(want)})\n`);
  if (!ok) failed++;
}

const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'statusline-')));
const project = path.join(home, 'proj');
const other = path.join(home, 'other');
fs.mkdirSync(project);
fs.mkdirSync(other);
execFileSync('git', ['init', '-q', '-b', 'feat-x'], { cwd: project, stdio: 'ignore' });

// Пороги фиксированы, состояние — в песочнице. CLAUDE_PROJECT_DIR живой сессии
// убран: иначе anchorDir привязал бы режим к её корню, а не к project_dir.
const env = {
  ...process.env,
  HOME: home,
  AI_HOOKS_STATE_DIR: path.join(home, 'state'),
  AI_HOOKS_CTX_SOFT: '90000',
  AI_HOOKS_CTX_HAND: '150000',
  AI_HOOKS_CTX_HARD: '220000',
};
delete env.CLAUDE_PROJECT_DIR;

const ANSI = /\x1b\[[0-9;]*m/g;
const plain = (s) => s.replace(ANSI, '');

function line(input) {
  const raw = typeof input === 'string' ? input : JSON.stringify(input);
  return spawnSync('node', [STATUSLINE], { input: raw, encoding: 'utf8', env, cwd: other }).stdout;
}

const at = (dir, extra = {}) => ({ workspace: { current_dir: dir, project_dir: dir }, ...extra });

let seq = 0;
function transcript(tokens) {
  const file = path.join(home, `t${++seq}.jsonl`);
  fs.writeFileSync(file, `${JSON.stringify({
    type: 'assistant',
    message: { id: `m${seq}`, model: 'claude-opus-5', content: [], usage: { input_tokens: tokens, output_tokens: 0 } },
  })}\n`);
  return file;
}

// --- каталог и ветка ---
check('каталог под HOME → ~, ветка рядом', plain(line(at(project))).startsWith('~/proj  feat-x  '), true);
check('вне репозитория ветки нет', plain(line(at(other))).startsWith('~/other  ask mode'), true);
check('каталог вне HOME — как есть', plain(line(at('/tmp'))).startsWith('/tmp  '), true);

// --- модель ---
const colorOf = (name) => {
  const out = line(at(other, { model: { display_name: name } }));
  return out.match(new RegExp(`\\x1b\\[([0-9;]*)m${name}`))?.[1] || null;
};
check('opus — оранжевый', colorOf('Opus 5'), '1;38;2;255;138;20');
check('sonnet — жёлтый', colorOf('Sonnet 5'), '1;38;2;255;229;41');
check('fable — красный', colorOf('Fable 5.1'), '1;38;2;255;41;61');
check('прочее — бледный салат', colorOf('Haiku 4.5'), '1;38;2;185;255;120');
check('без модели — без значка', /\x1b\[1;38;2;(255|185)/.test(line(at(other))), false);

// --- контекст ---
const ctx = (tokens) => {
  const out = line(at(other, { transcript_path: transcript(tokens) }));
  const m = out.match(/\x1b\[([0-9;]*)m(ctx [^\x1b]*)/);
  return m ? [m[1], m[2]] : null;
};
check('без транскрипта — без ctx', plain(line(at(other))).includes('ctx'), false);
check('ниже soft — тускло', ctx(50_000), ['2', 'ctx 50k']);
check('soft — янтарный', ctx(100_000), ['1;38;2;230;180;0', 'ctx 100k']);
check('hand — красный без метки', ctx(160_000), ['1;38;2;230;80;60', 'ctx 160k']);
check('hard — красный с !', ctx(230_000), ['1;38;2;230;80;60', 'ctx 230k!']);

// --- ask mode ---
check('по умолчанию off', plain(line(at(project))).endsWith('ask mode off'), true);

execFileSync('node', [ASK_MODE, 'on'], { cwd: project, env, encoding: 'utf8' });
check('включён для корня → on', plain(line(at(project))).endsWith('ask mode on'), true);
check('cd в соседний каталог — режим корня сессии',
  plain(line({ workspace: { current_dir: other, project_dir: project } })).endsWith('ask mode on'), true);
check('другой корень — свой режим', plain(line(at(other))).endsWith('ask mode off'), true);

// --- битый stdin ---
check('битый stdin — строка всё равно есть', plain(line('{не json')).includes('ask mode'), true);

fs.rmSync(home, { recursive: true, force: true });
process.stdout.write(failed ? `\n=== ${failed} проверок упало ===\n` : '\n=== все проверки прошли ===\n');
process.exit(failed ? 1 : 0);
