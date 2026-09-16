#!/usr/bin/env node
// Claude Code, Stop: учёт токенов, стоимости и вызовов инструментов по сессии.
//
// Источник — транскрипт сессии (transcript_path из входа хука) плюс транскрипты
// субагентов рядом с ним. Claude Code пишет несколько строк на одно сообщение
// ассистента (по блоку контента), и в каждой полный usage — считать надо один
// раз на message.id. Запись в logs/usage.jsonl — одна на сессию, при каждом
// Stop перезаписывается (upsert по session_id), так что файл — снимок, а не
// журнал событий. Любая ошибка → тихий выход: учёт не должен ломать ответ.
//
// Источники контекста: размер каждого tool_result (символы) привязывается к
// tool_use по id и суммируется по инструменту, для Read — ещё и по файлу.
// Это то, что реально попадает в окно; токены оценивает отчёт.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { isEntryPoint } from '../state-core.mjs';

const HOME = process.env.HOME || os.homedir();
const LOG_DIR = path.join(HOME, '.ai-hooks', 'logs');
export const USAGE_FILE = path.join(LOG_DIR, 'usage.jsonl');

// USD за миллион токенов. Cache write — 5-минутный (×1.25 от input), для
// часового кэша ×2. Неизвестная модель считается по нулям и помечается.
export const PRICES = {
  'claude-fable-5-1': { input: 10, output: 50, cacheRead: 0.25, cacheWrite5m: 12.5, cacheWrite1h: 20 },
  'claude-fable-5': { input: 10, output: 50, cacheRead: 1, cacheWrite5m: 12.5, cacheWrite1h: 20 },
  'claude-opus-5': { input: 5, output: 25, cacheRead: 0.5, cacheWrite5m: 6.25, cacheWrite1h: 10 },
  'claude-opus-4-8': { input: 5, output: 25, cacheRead: 0.5, cacheWrite5m: 6.25, cacheWrite1h: 10 },
  'claude-sonnet-5': { input: 2, output: 10, cacheRead: 0.2, cacheWrite5m: 2.5, cacheWrite1h: 4 },
  'claude-sonnet-4-6': { input: 3, output: 15, cacheRead: 0.3, cacheWrite5m: 3.75, cacheWrite1h: 6 },
  'claude-haiku-4-5': { input: 1, output: 5, cacheRead: 0.1, cacheWrite5m: 1.25, cacheWrite1h: 2 },
};

function priceFor(model) {
  const key = Object.keys(PRICES).find((k) => String(model).startsWith(k));
  return key ? PRICES[key] : null;
}

function emptyModel() {
  return { input: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0, output: 0, messages: 0, cost: 0, priced: true };
}

function readLines(file) {
  try {
    return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

// Размер результата инструмента в символах: строка или массив блоков text.
function resultChars(content) {
  if (typeof content === 'string') return content.length;
  if (!Array.isArray(content)) return 0;
  return content.reduce((n, b) => n + (typeof b?.text === 'string' ? b.text.length : 0), 0);
}

// Запись user с tool_result → размер по инструменту и по файлу (Read).
function collectResults(rec, uses, sources) {
  if (!Array.isArray(rec.message?.content)) return;
  for (const block of rec.message.content) {
    if (block?.type !== 'tool_result') continue;
    const use = uses.get(block.tool_use_id) || { name: 'unknown' };
    const chars = resultChars(block.content);
    const t = sources.tools[use.name] || (sources.tools[use.name] = { calls: 0, chars: 0 });
    t.calls += 1;
    t.chars += chars;
    if (use.name === 'Read' && use.file) sources.files[use.file] = (sources.files[use.file] || 0) + chars;
  }
}

// Агрегирует один транскрипт в acc; вернёт число учтённых сообщений.
function collect(file, acc) {
  const seen = new Map(); // message.id → последняя строка с usage
  const uses = new Map(); // tool_use.id → { name, file }
  for (const line of readLines(file)) {
    let rec;
    try { rec = JSON.parse(line); } catch { continue; }
    if (rec.type === 'user') { collectResults(rec, uses, acc.context_sources); continue; }
    if (rec.type !== 'assistant' || !rec.message?.usage) continue;
    seen.set(rec.message.id || rec.uuid, rec);
    for (const block of rec.message.content || []) {
      if (block?.type !== 'tool_use' || !block.name) continue;
      acc.tools[block.name] = (acc.tools[block.name] || 0) + 1;
      if (block.id) uses.set(block.id, { name: block.name, file: block.input?.file_path });
    }
    if (rec.timestamp) {
      if (!acc.started || rec.timestamp < acc.started) acc.started = rec.timestamp;
      if (!acc.ended || rec.timestamp > acc.ended) acc.ended = rec.timestamp;
    }
  }
  for (const rec of seen.values()) {
    const u = rec.message.usage;
    const model = rec.message.model || 'unknown';
    const m = acc.models[model] || (acc.models[model] = emptyModel());
    const w5 = u.cache_creation?.ephemeral_5m_input_tokens;
    const w1 = u.cache_creation?.ephemeral_1h_input_tokens || 0;
    m.input += u.input_tokens || 0;
    m.cacheRead += u.cache_read_input_tokens || 0;
    m.cacheWrite5m += w5 ?? (u.cache_creation_input_tokens || 0);
    m.cacheWrite1h += w1;
    m.output += u.output_tokens || 0;
    m.messages += 1;
  }
  return seen.size;
}

function price(acc) {
  let total = 0;
  for (const [model, m] of Object.entries(acc.models)) {
    const p = priceFor(model);
    if (!p) { m.priced = false; continue; }
    m.cost = (m.input * p.input + m.cacheRead * p.cacheRead + m.cacheWrite5m * p.cacheWrite5m
      + m.cacheWrite1h * p.cacheWrite1h + m.output * p.output) / 1e6;
    m.cost = Math.round(m.cost * 10000) / 10000;
    total += m.cost;
  }
  acc.cost = Math.round(total * 10000) / 10000;
}

export function summarize({ session_id, transcript_path, cwd }) {
  if (!session_id || !transcript_path) return null;
  const acc = {
    session_id, project: cwd || '', started: null, ended: null, models: {}, tools: {},
    context_sources: { tools: {}, files: {} }, subagents: 0, cost: 0,
  };
  const main = collect(transcript_path, acc);
  const subDir = path.join(path.dirname(transcript_path), session_id, 'subagents');
  try {
    for (const f of fs.readdirSync(subDir)) {
      if (!f.endsWith('.jsonl')) continue;
      if (collect(path.join(subDir, f), acc) > 0) acc.subagents += 1;
    }
  } catch { /* субагентов не было */ }
  if (main === 0 && acc.subagents === 0) return null;
  price(acc);
  acc.updated = new Date().toISOString();
  return acc;
}

export function upsert(record, file = USAGE_FILE) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const kept = readLines(file).filter((l) => {
    try { return JSON.parse(l).session_id !== record.session_id; } catch { return false; }
  });
  kept.push(JSON.stringify(record));
  fs.writeFileSync(file, kept.join('\n') + '\n');
}

if (isEntryPoint(import.meta.url)) {
  let raw = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (c) => { raw += c; });
  process.stdin.on('end', () => {
    try {
      const record = summarize(JSON.parse(raw));
      if (record) upsert(record);
    } catch { /* учёт не должен ломать ответ */ }
    process.exit(0);
  });
}
