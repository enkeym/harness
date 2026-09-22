#!/usr/bin/env node
// Доля инструментов по сессиям Claude Code: чем модель искала и читала код —
// tokensave/rag_search или Read/grep через Bash — и сколько это стоило.
//
// Источник — транскрипты ~/.claude/projects/*/*.jsonl (основная цепочка, без
// sidechain). Считаются tool_use-блоки записей ассистента по группам:
//   ts     mcp__tokensave__* без session_*/record_* (поиск, чтение, правка)
//   rag    mcp__ragsave__rag_search
//   read   Read
//   grep   Grep, Glob и Bash с grep/rg/ag/find в команде
//   bash   остальной Bash
//   edit   Edit, Write
// deny — ответы «hook error» на вызовы инструментов (запреты и повторы).
// Стоимость — Σ(input + cache_read + cache_creation) по всем ответам ассистента:
// столько токенов контекста прочитала модель за сессию; out — Σ output.
//
// Запуск: node ~/.ai-hooks/bin/tool-share.mjs [ISO-граница] [минимальный размер, байт]
// Граница по умолчанию — a0ec8f2 (снятие принуждения к tokensave, 22.09.2026).

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, basename } from 'node:path';
import { homedir } from 'node:os';

const ROOT = join(homedir(), '.claude', 'projects');
const CUTOFF = process.argv[2] || '2026-09-22T08:54:12Z';
const MIN_SIZE = Number(process.argv[3]) || 50_000;

const GROUPS = ['ts', 'rag', 'read', 'grep', 'bash', 'edit'];
const SEARCH_RE = /(^|[\s|;&(])(grep|rg|ag|find)(\s|$)/;

function group(block) {
  const n = block.name ?? '';
  if (n.startsWith('mcp__tokensave__')) {
    return /__(session_start|session_end|record_)/.test(n) ? null : 'ts';
  }
  if (n === 'mcp__ragsave__rag_search') return 'rag';
  if (n === 'Read') return 'read';
  if (n === 'Grep' || n === 'Glob') return 'grep';
  if (n === 'Edit' || n === 'Write') return 'edit';
  if (n === 'Bash') return SEARCH_RE.test(block.input?.command ?? '') ? 'grep' : 'bash';
  return null;
}

function session(file) {
  const r = { file: basename(file).slice(0, 8), start: '', model: '', turns: 0, deny: 0, ctx: 0, out: 0 };
  for (const g of GROUPS) r[g] = 0;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line) continue;
    let rec;
    try { rec = JSON.parse(line); } catch { continue; }
    if (rec.isSidechain) continue;
    if (!r.start && rec.timestamp) r.start = rec.timestamp;
    const content = rec.message?.content;
    if (!Array.isArray(content)) continue;
    if (rec.type === 'assistant') {
      const u = rec.message.usage;
      if (u) {
        r.turns += 1;
        r.model = (rec.message.model ?? '').replace('claude-', '');
        r.ctx += (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
        r.out += u.output_tokens ?? 0;
      }
      for (const b of content) {
        if (b.type !== 'tool_use') continue;
        const g = group(b);
        if (g) r[g] += 1;
      }
    } else if (rec.type === 'user') {
      for (const b of content) {
        if (b.type === 'tool_result' && b.is_error && /hook error/.test(JSON.stringify(b.content ?? ''))) r.deny += 1;
      }
    }
  }
  return r.turns ? r : null;
}

const rows = [];
for (const proj of readdirSync(ROOT)) {
  const dir = join(ROOT, proj);
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.jsonl')) continue;
    const file = join(dir, f);
    if (statSync(file).size < MIN_SIZE) continue;
    const r = session(file);
    if (r) rows.push({ proj: proj.replace('-home-enkeym', '') || '/', ...r });
  }
}
rows.sort((a, b) => a.start.localeCompare(b.start));

const pct = (n, d) => (d ? Math.round((100 * n) / d) : 0);
const k = (n) => `${Math.round(n / 1000)}k`;
// Доля «умных» инструментов среди всех поисков и чтений.
const share = (r) => pct(r.ts + r.rag, r.ts + r.rag + r.read + r.grep);

const head = ['proj', 'file', 'start', 'model', 'turns', ...GROUPS, 'deny', 'share%', 'ctx', 'ctx/turn', 'out'];
console.log(head.join('\t'));
for (const r of rows) {
  console.log([r.proj, r.file, r.start.slice(0, 16), r.model, r.turns, ...GROUPS.map((g) => r[g]),
    r.deny, share(r), k(r.ctx), k(r.ctx / r.turns), k(r.out)].join('\t'));
}

// Итог до и после границы — по проектам и всего.
function total(list) {
  const t = { turns: 0, deny: 0, ctx: 0, out: 0, n: list.length };
  for (const g of GROUPS) t[g] = 0;
  for (const r of list) for (const key of ['turns', 'deny', 'ctx', 'out', ...GROUPS]) t[key] += r[key];
  return t;
}
function printTotal(label, list) {
  if (!list.length) return;
  const t = total(list);
  console.log([label, `${t.n} сессий`, t.turns, ...GROUPS.map((g) => t[g]), t.deny, share(t), k(t.ctx), k(t.ctx / t.turns), k(t.out)].join('\t'));
}

console.log('');
console.log(['период', 'сессии', 'turns', ...GROUPS, 'deny', 'share%', 'ctx', 'ctx/turn', 'out'].join('\t'));
for (const proj of [...new Set(rows.map((r) => r.proj))]) {
  const mine = rows.filter((r) => r.proj === proj);
  printTotal(`${proj} до`, mine.filter((r) => r.start < CUTOFF));
  printTotal(`${proj} после`, mine.filter((r) => r.start >= CUTOFF));
}
printTotal('всего до', rows.filter((r) => r.start < CUTOFF));
printTotal('всего после', rows.filter((r) => r.start >= CUTOFF));
