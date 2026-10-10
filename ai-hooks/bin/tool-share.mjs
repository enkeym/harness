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
// deny — отказы хуков на вызовы инструментов: «hook error» в тексте или
// toolDenialKind permission-rule (новые версии пишут отказ без префикса).
// Один ответ API лежит в транскрипте несколькими записями — по блоку на запись,
// с одним message.id и одной и той же usage: turns, ctx и out считаются по
// message.id один раз. Стоимость — Σ(input + cache_read + cache_creation) по
// ответам: столько токенов контекста прочитала модель за сессию; out — Σ output.
// Запись с моделью <synthetic> — без вызова API (ошибка /login, «No response
// requested») — не ответ: не в turns и не в модель.
//
// --waste первым аргументом — вместо долей цена лишних вызовов в сессиях после
// границы. Окно вызова API — input + cache_read + cache_creation; сегмент
// (то, что модель держит в окне) сбрасывается, когда окно падает вдвое. Классы:
//   deny        отказ хука; повтор той же цели следом — в примечании
//   error       ошибка инструмента, кроме Bash и отказов пользователя
//   stop        блок Stop (question-guard)
//   reread      то же чтение (инструмент, путь, диапазон) в сегменте без правки
//               пути между ними и без if_digest
//   fullread    tokensave_read full/map файла кода > 2k ток. без правки после
//   bigbash     вывод Bash сверх 5k ток.
//   toolsearch  повторная загрузка той же схемы — только случаи: схемы приходят
//               ссылками tool_reference, их размера в транскрипте нет
//   skill       повторный текст скилла
//   meter       текст context-meter; links — текст карты связей
//   handoff     Σ(окно − 150k) по вызовам сегмента до Skill handoff
// Цена deny, error, stop — следующий вызов API целиком (один раз на вызов);
// остальных — токены текста (символы/4) в каждом оставшемся вызове сегмента.
// $ — по PRICES из usage-log: текст пишется в кэш раз (1h, если вызов писал
// часовой) и читается из кэша в каждом следующем; handoff — по чтению кэша.
// Недостающие вызовы — счётчиками: повторный tokensave_read без if_digest,
// tokensave_search без path_include с выводом > 2k ток., tokensave_context.
//
// Запуск — USAGE ниже. Граница по умолчанию — a0ec8f2 (снятие принуждения к
// tokensave, 22.09.2026).

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, basename } from 'node:path';
import { homedir } from 'node:os';
import { priceFor } from '../claude/usage-log.mjs';
import { MCP_EDIT_RE } from '../skill-core.mjs';

const ROOT = join(homedir(), '.claude', 'projects');
// Каталог проекта — его путь, где всё кроме [a-zA-Z0-9] заменено на '-'.
const HOME_DIR = homedir().replace(/[^a-zA-Z0-9]/g, '-');
const DEFAULT_CUTOFF = '2026-09-22T08:54:12Z';
const DEFAULT_MIN_SIZE = 50_000;
const USAGE = `Запуск: node ~/.ai-hooks/bin/tool-share.mjs [--waste] [ISO-граница] [минимальный размер, байт]
  --waste — цена лишних вызовов по классам, топ сессий и недостающие вызовы (после границы)
  ISO-граница — UTC: 2026-09-22 или 2026-09-22T08:54:12Z; по умолчанию ${DEFAULT_CUTOFF}
  размер — целое число байт; по умолчанию ${DEFAULT_MIN_SIZE}
`;
// Граница сравнивается с timestamp записей как строка: не-дата или часовой пояс не Z
// молча уводят сессии не в тот период.
const CUTOFF_RE = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?Z)?$/;

function usage(code) {
  (code ? process.stderr : process.stdout).write(USAGE);
  process.exit(code);
}

const args = process.argv.slice(2);
const WASTE = args[0] === '--waste';
if (WASTE) args.shift();
const [cutoffArg, sizeArg] = args;
if (cutoffArg === '--help' || cutoffArg === '-h') usage(0);
const CUTOFF = cutoffArg ?? DEFAULT_CUTOFF;
if (!CUTOFF_RE.test(CUTOFF) || Number.isNaN(Date.parse(CUTOFF))) usage(1);
if (sizeArg !== undefined && !/^\d+$/.test(sizeArg)) usage(1);
const MIN_SIZE = sizeArg === undefined ? DEFAULT_MIN_SIZE : Number(sizeArg);

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

// Записи основной цепочки транскрипта по порядку.
function* records(file) {
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line) continue;
    let rec;
    try { rec = JSON.parse(line); } catch { continue; }
    if (!rec.isSidechain) yield rec;
  }
}

const text = (content) => (typeof content === 'string' ? content : JSON.stringify(content ?? ''));
const isDeny = (rec, b) => b.is_error && (rec.toolDenialKind === 'permission-rule' || /hook error/.test(text(b.content)));

function session(file) {
  const r = { file: basename(file).slice(0, 8), start: '', model: '', turns: 0, deny: 0, ctx: 0, out: 0 };
  for (const g of GROUPS) r[g] = 0;
  const answered = new Set();
  for (const rec of records(file)) {
    if (!r.start && rec.timestamp) r.start = rec.timestamp;
    const content = rec.message?.content;
    if (!Array.isArray(content)) continue;
    if (rec.type === 'assistant') {
      if (rec.message.model === '<synthetic>') continue;
      const u = rec.message.usage;
      const id = rec.message.id ?? rec.uuid;
      if (u && !answered.has(id)) {
        answered.add(id);
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
        if (b.type === 'tool_result' && isDeny(rec, b)) r.deny += 1;
      }
    }
  }
  return r.turns ? r : null;
}

const CHARS_PER_TOKEN = 4;
const BIG_BASH_TOK = 5000;
const FULL_READ_TOK = 2000;
const WIDE_SEARCH_TOK = 2000;
const HANDOFF_TOK = 150_000;
const TS_READ = 'mcp__tokensave__tokensave_read';
const TS_SEARCH = 'mcp__tokensave__tokensave_search';
const TS_CONTEXT = 'mcp__tokensave__tokensave_context';
const isEdit = (name) => /^(Edit|Write|NotebookEdit)$/.test(name) || MCP_EDIT_RE.test(name);
const CODE_RE = /\.(m?[jt]sx?|c[jt]s|py|rs|go|java|kt|rb|php|cs|swift|c|cc|cpp|h|hpp|sh)$/;
const METER_RE = /В контексте \d+k|Контекст занят|context-meter:/;
const LINKS_PREFIX = 'Карта неявных связей';
const STOP_PREFIX = 'Stop hook feedback:';
const WASTE_CLASSES = ['deny', 'error', 'stop', 'reread', 'fullread', 'bigbash', 'toolsearch', 'skill', 'meter', 'links', 'handoff'];

// Текст результата, вложения или meta-записи: строка, блоки text или строки.
const plain = (c) => (typeof c === 'string' ? c
  : Array.isArray(c) ? c.map((b) => (typeof b === 'string' ? b : b?.text ?? '')).join('') : '');
const tokens = (c) => Math.round(plain(c).length / CHARS_PER_TOKEN);
const rel = (p, cwd) => (typeof p === 'string' && cwd && p.startsWith(`${cwd}/`) ? p.slice(cwd.length + 1) : p);

// Цена лишних вызовов одной сессии: классы → { n, tok, usd }, счётчики недостающих.
function waste(file) {
  const calls = []; // { win, seg, usd, p, w1h }
  const events = []; // { cls, at: индекс вызова, после которого текст вошёл в окно, tok, kind }
  const uses = new Map(); // tool_use.id → { name, input, at, path }
  const answered = new Set();
  const r = { usd: 0, repeat: 0, noDigest: 0, noDigestTok: 0, wide: 0, wideTok: 0, context: 0 };
  const fresh = () => ({ reads: new Map(), full: new Map(), names: new Set(), skills: new Set(), handed: false });
  let state = fresh();
  let seg = 0;
  let cwd = '';
  let lastDeny = null;
  const carry = (cls, at, tok) => events.push({ cls, at, tok, kind: 'carry' });
  // Полное чтение без правки до конца сегмента — в потери.
  const flush = () => { for (const list of state.full.values()) events.push(...list); };

  function addCall(u, model) {
    const win = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
    const prev = calls.at(-1);
    if (prev && win < prev.win / 2) { flush(); seg += 1; state = fresh(); }
    const p = priceFor(model);
    const w1 = u.cache_creation?.ephemeral_1h_input_tokens ?? 0;
    const usd = p ? ((u.input_tokens ?? 0) * p.input + (u.cache_read_input_tokens ?? 0) * p.cacheRead
      + ((u.cache_creation_input_tokens ?? 0) - w1) * p.cacheWrite5m + w1 * p.cacheWrite1h
      + (u.output_tokens ?? 0) * p.output) / 1e6 : 0;
    calls.push({ win, seg, usd, p, w1h: w1 > 0 });
    r.usd += usd;
    if (win > HANDOFF_TOK && !state.handed) events.push({ cls: 'handoff', at: calls.length - 1, tok: win - HANDOFF_TOK, kind: 'self' });
  }

  function onUse(b) {
    const input = b.input ?? {};
    const path = rel(input.file_path ?? input.notebook_path ?? input.file ?? input.path, cwd);
    uses.set(b.id, { name: b.name, input, at: calls.length - 1, path });
    if (lastDeny) {
      if (lastDeny.name === b.name && JSON.stringify(lastDeny.input) === JSON.stringify(input)) r.repeat += 1;
      lastDeny = null;
    }
    if (path && isEdit(b.name)) { state.reads.delete(path); state.full.delete(path); }
    if (b.name === 'Skill' && input.skill === 'handoff') state.handed = true;
    if (b.name === TS_CONTEXT) r.context += 1;
  }

  function onRead(use, tok) {
    if (!use.path || use.input.if_digest) return;
    const { name, input } = use;
    const mode = input.mode ?? 'full';
    const key = JSON.stringify([name, input.offset, input.limit, mode, input.lines, input.graph_root]);
    const seen = state.reads.get(use.path) ?? new Set();
    if (seen.has(key)) {
      carry('reread', use.at, tok);
      if (name === TS_READ) { r.noDigest += 1; r.noDigestTok += tok; }
      return;
    }
    seen.add(key);
    state.reads.set(use.path, seen);
    if (name === TS_READ && (mode === 'full' || mode === 'map') && CODE_RE.test(use.path) && tok > FULL_READ_TOK) {
      const list = state.full.get(use.path) ?? [];
      list.push({ cls: 'fullread', at: use.at, tok, kind: 'carry' });
      state.full.set(use.path, list);
    }
  }

  function onResult(rec, b) {
    const use = uses.get(b.tool_use_id) ?? { name: 'unknown', input: {}, at: calls.length - 1 };
    if (b.is_error) {
      if (isDeny(rec, b)) { events.push({ cls: 'deny', at: use.at, kind: 'next' }); lastDeny = use; }
      else if (!rec.toolDenialKind && use.name !== 'Bash') events.push({ cls: 'error', at: use.at, kind: 'next' });
      return;
    }
    const tok = tokens(b.content);
    if (use.name === 'Bash') {
      if (tok > BIG_BASH_TOK) carry('bigbash', use.at, tok - BIG_BASH_TOK);
    } else if (use.name === 'ToolSearch') {
      const q = String(use.input.query ?? '');
      const names = q.startsWith('select:') ? q.slice(7).split(',').map((s) => s.trim()).filter(Boolean) : [`?${q}`];
      if (names.some((n) => state.names.has(n))) events.push({ cls: 'toolsearch', at: use.at, kind: 'count' });
      for (const n of names) state.names.add(n);
    } else if (use.name === 'Read' || use.name === TS_READ) {
      onRead(use, tok);
    } else if (use.name === TS_SEARCH && !use.input.path_include?.length && tok > WIDE_SEARCH_TOK) {
      r.wide += 1;
      r.wideTok += tok;
    }
  }

  for (const rec of records(file)) {
    if (rec.cwd) cwd = rec.cwd;
    const content = rec.message?.content;
    if (rec.type === 'assistant' && Array.isArray(content)) {
      if (rec.message.model === '<synthetic>') continue;
      const id = rec.message.id ?? rec.uuid;
      if (rec.message.usage && !answered.has(id)) {
        answered.add(id);
        addCall(rec.message.usage, rec.message.model);
      }
      for (const b of content) if (b.type === 'tool_use') onUse(b);
    } else if (rec.type === 'user' && rec.isMeta) {
      const at = calls.length - 1;
      if (plain(content).startsWith(STOP_PREFIX)) events.push({ cls: 'stop', at, kind: 'next' });
      const use = uses.get(rec.sourceToolUseID);
      if (use?.name === 'Skill') {
        if (state.skills.has(use.input.skill)) carry('skill', at, tokens(content));
        state.skills.add(use.input.skill);
      }
    } else if (rec.type === 'user' && Array.isArray(content)) {
      for (const b of content) if (b.type === 'tool_result') onResult(rec, b);
    } else if (rec.type === 'attachment' && rec.attachment?.type === 'hook_additional_context') {
      const s = plain(rec.attachment.content);
      if (METER_RE.test(s)) carry('meter', calls.length - 1, tokens(s));
      else if (s.startsWith(LINKS_PREFIX)) carry('links', calls.length - 1, tokens(s));
    }
  }
  flush();

  // left[i] — вызовов от i до конца его сегмента включительно.
  const left = [];
  for (let i = calls.length - 1; i >= 0; i--) left[i] = 1 + (calls[i + 1]?.seg === calls[i].seg ? left[i + 1] : 0);
  const classes = {};
  const charged = new Set();
  for (const e of events) {
    const c = classes[e.cls] ??= { n: 0, tok: 0, usd: 0 };
    c.n += 1;
    if (e.kind === 'count') continue;
    if (e.kind === 'self') {
      c.tok += e.tok;
      c.usd += (e.tok * (calls[e.at].p?.cacheRead ?? 0)) / 1e6;
      continue;
    }
    const next = calls[e.at + 1];
    if (!next) continue;
    if (e.kind === 'next') {
      if (charged.has(e.at)) continue;
      charged.add(e.at);
      c.tok += next.win;
      c.usd += next.usd;
      continue;
    }
    const n = left[e.at + 1];
    c.tok += e.tok * n;
    if (next.p) c.usd += (e.tok * ((next.w1h ? next.p.cacheWrite1h : next.p.cacheWrite5m) + (n - 1) * next.p.cacheRead)) / 1e6;
  }
  return { classes, ...r };
}

const rows = [];
for (const proj of readdirSync(ROOT)) {
  const dir = join(ROOT, proj);
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.jsonl')) continue;
    const file = join(dir, f);
    if (statSync(file).size < MIN_SIZE) continue;
    const r = session(file);
    if (r) rows.push({ proj: proj.replace(HOME_DIR, '') || '~', path: file, ...r });
  }
}
rows.sort((a, b) => a.start.localeCompare(b.start));

const pct = (n, d) => (d ? Math.round((100 * n) / d) : 0);
const k = (n) => `${Math.round(n / 1000)}k`;
const k1 = (n) => `${(n / 1000).toFixed(1)}k`;
const usd = (n) => n.toFixed(2);

// Отчёт --waste: классы по убыванию $, топ-10 сессий, недостающие вызовы.
function printWaste(list) {
  const all = Object.fromEntries(WASTE_CLASSES.map((c) => [c, { n: 0, tok: 0, usd: 0, top: null }]));
  const t = { turns: 0, ctx: 0, usd: 0, repeat: 0, noDigest: 0, noDigestTok: 0, noDigestS: 0, wide: 0, wideTok: 0, wideS: 0, context: 0, contextS: 0 };
  for (const r of list) {
    const w = r.waste;
    t.turns += r.turns;
    t.ctx += r.ctx;
    for (const key of ['usd', 'repeat', 'noDigest', 'noDigestTok', 'wide', 'wideTok', 'context']) t[key] += w[key];
    if (w.noDigest) t.noDigestS += 1;
    if (w.wide) t.wideS += 1;
    if (w.context) t.contextS += 1;
    r.lost = { tok: 0, usd: 0, top: '' };
    for (const [cls, c] of Object.entries(w.classes)) {
      const a = all[cls];
      a.n += c.n;
      a.tok += c.tok;
      a.usd += c.usd;
      if (!a.top || c.usd > a.top.usd) a.top = { file: r.file, usd: c.usd };
      r.lost.tok += c.tok;
      r.lost.usd += c.usd;
      if (!r.lost.top || c.usd > w.classes[r.lost.top].usd) r.lost.top = cls;
    }
  }
  console.log(`сессий ${list.length}, ходов ${t.turns}, ctx ${k(t.ctx)}, $${usd(t.usd)}`);
  console.log('');
  console.log(['класс', 'случаи', 'ток.', '$', '%$', 'пример', 'примечание'].join('\t'));
  for (const cls of WASTE_CLASSES.filter((c) => all[c].n).sort((a, b) => all[b].usd - all[a].usd)) {
    const a = all[cls];
    const note = cls === 'deny' ? `повтор той же цели: ${t.repeat}`
      : cls === 'toolsearch' ? 'размер схем в транскрипте не виден' : '';
    console.log([cls, a.n, k1(a.tok), usd(a.usd), pct(a.usd, t.usd), a.top.file, note].join('\t'));
  }
  console.log('');
  console.log(['proj', 'file', 'start', 'turns', 'ctx', 'ток.', '$', 'класс'].join('\t'));
  for (const r of [...list].sort((a, b) => b.lost.usd - a.lost.usd).slice(0, 10).filter((r) => r.lost.tok)) {
    console.log([r.proj, r.file, r.start.slice(0, 16), r.turns, k(r.ctx), k1(r.lost.tok), usd(r.lost.usd), r.lost.top].join('\t'));
  }
  console.log('');
  console.log(['недостающий', 'случаи', 'сессии', 'ток.'].join('\t'));
  console.log(['read без if_digest', t.noDigest, t.noDigestS, k1(t.noDigestTok)].join('\t'));
  console.log(['search без path_include', t.wide, t.wideS, k1(t.wideTok)].join('\t'));
  console.log(['tokensave_context', t.context, t.contextS, '—'].join('\t'));
}

if (WASTE) {
  const after = rows.filter((r) => r.start >= CUTOFF);
  for (const r of after) r.waste = waste(r.path);
  printWaste(after);
  process.exit(0);
}
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
