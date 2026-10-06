#!/usr/bin/env node
// Тесты стартовой цены сессий (bin/start-cost.mjs): слои считаются по
// attachment-записям до первого ответа основной нити, кириллица и латиница
// оцениваются по своим коэффициентам, промпт без служебных записей; Σreal — из
// usage первого настоящего ответа (запись <synthetic> — без вызова API — не
// в счёт), rest — остаток; маленькие файлы и сессии без ответа в таблицу не
// попадают.

import './env-isolate.mjs';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SCRIPT = path.join(ROOT, 'bin', 'start-cost.mjs');

let failed = 0;
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  process.stdout.write(`${ok ? 'ok  ' : 'FAIL'} ${name} (got=${JSON.stringify(got)}, want=${JSON.stringify(want)})\n`);
  if (!ok) failed++;
}

// Транскрипты лежат под HOME/.claude/projects — скрипт видит только песочницу.
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'start-cost-'));
const projects = path.join(home, '.claude', 'projects');
// Каталог проекта — его путь, где всё кроме [a-zA-Z0-9] заменено на '-'.
const homeDir = home.replace(/[^a-zA-Z0-9]/g, '-');

function transcript(proj, name, recs) {
  const dir = path.join(projects, proj);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name), `${recs.map((r) => JSON.stringify(r)).join('\n')}\n`);
}

// Длины кратны делителям: 'x'.repeat(4n) — n токенов, кириллица 'я'.repeat(22) — 10.
const lat = (tokens) => 'x'.repeat(tokens * 4);
const att = (attachment) => ({ type: 'attachment', attachment });
const assistant = (read, create, extra = {}, model = 'claude-opus-5') => ({
  type: 'assistant', ...extra,
  message: { model, usage: { cache_read_input_tokens: read, cache_creation_input_tokens: create } },
});

transcript(`${homeDir}-demo`, 'aaaaaaaa-1.jsonl', [
  { type: 'system', version: '2.5.0' },
  att({ type: 'prompt_snapshot', systemPrompt: lat(100) }),
  att({ type: 'skill_listing', content: lat(20) }),
  att({ type: 'instructions', files: [{ path: '/x/CLAUDE.md', content: lat(30) }, { path: '/x/core.md', content: 'я'.repeat(22) }] }),
  att({ type: 'deferred_tools_delta', addedLines: 'abcdefgh' }),
  att({ type: 'mcp_instructions_delta', addedBlocks: 'ab' }),
  att({ type: 'session_context', context: lat(5) }),
  { type: 'user', message: { content: lat(7) } },
  { type: 'user', isMeta: true, message: { content: lat(1000) } },
  { type: 'user', message: { content: `<command-name>/clear</command-name>${lat(1000)}` } },
  assistant(1, 1, { isSidechain: true }),
  assistant(0, 0, {}, '<synthetic>'),
  assistant(300, 50),
  att({ type: 'skill_listing', content: lat(9999) }),
]);
transcript(homeDir, 'bbbbbbbb-2.jsonl', [assistant(10, 0)]);
transcript(homeDir, 'cccccccc-3.jsonl', [att({ type: 'skill_listing', content: lat(10) })]);
transcript(homeDir, 'notes.txt', [assistant(1, 1)]);

function table(...args) {
  const out = spawnSync('node', [SCRIPT, ...args], { encoding: 'utf8', env: { ...process.env, HOME: home } }).stdout;
  const [head, ...rows] = out.trim().split('\n').map((l) => l.split('\t'));
  return rows.map((r) => Object.fromEntries(head.map((h, i) => [h, r[i]])));
}

// --- аргументы: неверный — использование и код 1, а не порог по умолчанию ---
{
  const run = (...args) => spawnSync('node', [SCRIPT, ...args], { encoding: 'utf8', env: { ...process.env, HOME: home } });
  const help = run('--help');
  check('--help — использование, код 0', [help.status, help.stdout.startsWith('Запуск:')], [0, true]);
  for (const arg of ['abc', '-5', '1e3']) {
    const r = run(arg);
    check(`${arg} — использование в stderr, код 1`, [r.status, r.stdout, r.stderr.startsWith('Запуск:')], [1, '', true]);
  }
}

// --- порог размера ---
check('по умолчанию маленькие файлы пропущены', table().length, 0);

const rows = table('1');
check('без ответа ассистента и не .jsonl — строк нет, порядок по проекту', rows.map((r) => r.file), ['aaaaaaaa', 'bbbbbbbb']);

const [demo, root] = rows;

// --- проект ---
check('сам каталог HOME — ~', root.proj, '~');
check('префикс каталога HOME срезан', demo.proj, '-demo');

// --- слои ---
check('версия и модель без claude-', [demo.ver, demo.model], ['2.5.0', 'opus-5']);
check('слои: sys / skills / instr / defer / mcp / ctx',
  [demo.sys, demo.skills, demo.instr, demo.defer, demo.mcp, demo.ctx], ['100', '20', '40', '2', '1', '5']);
check('промпт без isMeta и служебной команды', demo.prompt, '7');
check('файлы инструкций с их весом', demo.instrFiles, 'CLAUDE.md:30 core.md:10');
check('после первого ответа слои не читаются', demo.skills, '20');

// --- итоги ---
check('Σreal — из основной нити, не субагента и не <synthetic>', [demo.read, demo.create, demo['Σreal']], ['300', '50', '350']);
check('Σest и rest', [demo['Σest'], demo.rest], ['175', '175']);

fs.rmSync(home, { recursive: true, force: true });
process.stdout.write(failed ? `\n=== ${failed} проверок упало ===\n` : '\n=== все проверки прошли ===\n');
process.exit(failed ? 1 : 0);
