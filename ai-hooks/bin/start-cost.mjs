#!/usr/bin/env node
// Стартовая цена сессий Claude Code по слоям: что лежит в окне до первого ответа.
//
// Источник — транскрипты ~/.claude/projects/*/*.jsonl. До первой записи
// ассистента Claude Code пишет attachment-записи с тем, что ушло в промпт:
// prompt_snapshot (системный промпт), skill_listing, instructions (CLAUDE.md,
// core.md, память), deferred_tools_delta (имена отложенных инструментов),
// mcp_instructions_delta, session_context. Схем инструментов там нет — они
// видны только как остаток: Σreal (cache_read + cache_creation первого настоящего
// ответа ассистента) минус Σest. Запись с моделью <synthetic> — без вызова
// API (ошибка /login, «No response requested»), usage в ней нулевой — пропускается.
//
// Оценка токенов — эвристика: кириллица ≈2.2 символа на токен, остальное ≈4;
// на 35 сессиях сходится с usage в пределах 1–3k.
//
// Запуск — USAGE ниже.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, basename } from 'node:path';
import { homedir } from 'node:os';

const ROOT = join(homedir(), '.claude', 'projects');
// Каталог проекта — его путь, где всё кроме [a-zA-Z0-9] заменено на '-'.
const HOME_DIR = homedir().replace(/[^a-zA-Z0-9]/g, '-');
const DEFAULT_MIN_SIZE = 50_000;
const USAGE = `Запуск: node ~/.ai-hooks/bin/start-cost.mjs [минимальный размер файла, байт]
  размер — целое число байт; по умолчанию ${DEFAULT_MIN_SIZE}
`;

function usage(code) {
  (code ? process.stderr : process.stdout).write(USAGE);
  process.exit(code);
}

const sizeArg = process.argv[2];
if (sizeArg === '--help' || sizeArg === '-h') usage(0);
if (sizeArg !== undefined && !/^\d+$/.test(sizeArg)) usage(1);
const MIN_SIZE = sizeArg === undefined ? DEFAULT_MIN_SIZE : Number(sizeArg);

const tok = (s) => {
  if (!s) return 0;
  const cyr = (s.match(/[Ѐ-ӿ]/g) ?? []).length;
  return Math.round(cyr / 2.2 + (s.length - cyr) / 4);
};
const str = (v) => (typeof v === 'string' ? v : JSON.stringify(v ?? ''));

// Слои одной сессии по записям до первого ответа ассистента.
function layers(file) {
  const r = { file: basename(file).slice(0, 8), version: '', model: '',
    sys: 0, skills: 0, instr: 0, instrFiles: [], deferred: 0, mcp: 0, ctx: 0, prompt: 0, read: 0, create: 0 };
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line) continue;
    let rec;
    try { rec = JSON.parse(line); } catch { continue; }
    if (rec.isSidechain) continue;
    if (rec.version) r.version = rec.version;
    if (rec.type === 'assistant') {
      const u = rec.message?.usage;
      if (!u || rec.message.model === '<synthetic>') continue;
      r.model = (rec.message.model ?? '').replace('claude-', '');
      r.read = u.cache_read_input_tokens ?? 0;
      r.create = u.cache_creation_input_tokens ?? 0;
      return r;
    }
    if (rec.type === 'user' && !rec.isMeta) {
      const s = str(rec.message?.content);
      if (!s.includes('<command-name>')) r.prompt += tok(s);
    }
    if (rec.type !== 'attachment') continue;
    const a = rec.attachment;
    switch (a.type) {
      case 'prompt_snapshot': r.sys = tok(str(a.systemPrompt)); break;
      case 'skill_listing': r.skills = tok(a.content); break;
      case 'instructions':
        for (const f of a.files) {
          r.instr += tok(f.content);
          r.instrFiles.push(`${basename(f.path)}:${tok(f.content)}`);
        }
        break;
      case 'deferred_tools_delta': r.deferred = tok(str(a.addedLines)); break;
      case 'mcp_instructions_delta': r.mcp = tok(str(a.addedBlocks)); break;
      case 'session_context': r.ctx = tok(str(a.context)); break;
    }
  }
  return null;
}

const rows = [];
for (const proj of readdirSync(ROOT)) {
  const dir = join(ROOT, proj);
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.jsonl')) continue;
    const file = join(dir, f);
    if (statSync(file).size < MIN_SIZE) continue;
    const r = layers(file);
    if (r) rows.push({ proj: proj.replace(HOME_DIR, '') || '~', ...r });
  }
}
rows.sort((a, b) => (a.proj + a.file).localeCompare(b.proj + b.file));

const head = ['proj', 'file', 'ver', 'model', 'sys', 'skills', 'instr', 'defer', 'mcp', 'ctx', 'prompt', 'Σest', 'read', 'create', 'Σreal', 'rest', 'instrFiles'];
console.log(head.join('\t'));
for (const r of rows) {
  const est = r.sys + r.skills + r.instr + r.deferred + r.mcp + r.ctx + r.prompt;
  const real = r.read + r.create;
  console.log([r.proj, r.file, r.version, r.model, r.sys, r.skills, r.instr, r.deferred, r.mcp, r.ctx,
    r.prompt, est, r.read, r.create, real, real - est, r.instrFiles.join(' ')].join('\t'));
}
