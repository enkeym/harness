#!/usr/bin/env node
// Отчёт по logs/usage.jsonl: токены, стоимость, инструменты, субагенты.
//
//   usage-report.mjs            — последние 7 дней
//   usage-report.mjs --days 30  — последние N дней
//   usage-report.mjs --today
//   usage-report.mjs --project vpn-new   — фильтр по подстроке пути проекта
//   usage-report.mjs --sessions          — построчно по сессиям

import fs from 'node:fs';
import { USAGE_FILE } from '../claude/usage-log.mjs';

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const value = (name, def) => { const i = args.indexOf(name); return i !== -1 ? args[i + 1] : def; };

const days = flag('--today') ? 1 : Number(value('--days', 7));
const projectFilter = value('--project', '');
const since = flag('--today')
  ? new Date(new Date().toDateString()).getTime()
  : Date.now() - days * 24 * 3600 * 1000;

let records = [];
try {
  records = fs.readFileSync(USAGE_FILE, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
} catch {
  process.stdout.write(`Нет данных: ${USAGE_FILE} ещё не создан (хук Stop пишет его после первого ответа).\n`);
  process.exit(0);
}

records = records.filter((r) => r.ended && new Date(r.ended).getTime() >= since
  && (!projectFilter || String(r.project).includes(projectFilter)));

if (records.length === 0) {
  process.stdout.write('Сессий за период нет.\n');
  process.exit(0);
}

const k = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(n));
const usd = (n) => `$${n.toFixed(2)}`;
const proj = (p) => String(p).replace(process.env.HOME || '', '~');
const pad = (s, w) => String(s).padEnd(w);
const rpad = (s, w) => String(s).padStart(w);

const byProject = {};
const byModel = {};
const tools = {};
let total = 0;
let subagents = 0;

for (const r of records) {
  total += r.cost || 0;
  subagents += r.subagents || 0;
  const p = byProject[proj(r.project)] || (byProject[proj(r.project)] = { sessions: 0, cost: 0 });
  p.sessions += 1;
  p.cost += r.cost || 0;
  for (const [model, m] of Object.entries(r.models || {})) {
    const acc = byModel[model] || (byModel[model] = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, cost: 0, priced: true });
    acc.input += m.input; acc.cacheRead += m.cacheRead;
    acc.cacheWrite += (m.cacheWrite5m || 0) + (m.cacheWrite1h || 0);
    acc.output += m.output; acc.cost += m.cost || 0;
    if (m.priced === false) acc.priced = false;
  }
  for (const [name, n] of Object.entries(r.tools || {})) tools[name] = (tools[name] || 0) + n;
}

const period = flag('--today') ? 'сегодня' : `${days} дн.`;
let out = `Период: ${period} · сессий: ${records.length} · субагентов: ${subagents} · оценка стоимости: ${usd(total)}\n\n`;

out += 'По моделям (input / cache read / cache write / output → $):\n';
for (const [model, m] of Object.entries(byModel).sort((a, b) => b[1].cost - a[1].cost)) {
  out += `  ${pad(model, 22)} ${rpad(k(m.input), 8)} ${rpad(k(m.cacheRead), 9)} ${rpad(k(m.cacheWrite), 9)} ${rpad(k(m.output), 8)}  ${rpad(usd(m.cost), 8)}${m.priced ? '' : '  (нет цены)'}\n`;
}

out += '\nПо проектам:\n';
for (const [p, v] of Object.entries(byProject).sort((a, b) => b[1].cost - a[1].cost)) {
  out += `  ${pad(p, 40)} ${rpad(v.sessions, 3)} сес.  ${rpad(usd(v.cost), 8)}\n`;
}

out += '\nИнструменты (топ-12):\n';
for (const [name, n] of Object.entries(tools).sort((a, b) => b[1] - a[1]).slice(0, 12)) {
  out += `  ${pad(name, 44)} ${rpad(n, 5)}\n`;
}

if (flag('--sessions')) {
  out += '\nСессии:\n';
  for (const r of records.sort((a, b) => a.ended.localeCompare(b.ended))) {
    const models = Object.keys(r.models || {}).map((m) => m.replace('claude-', '')).join(',');
    out += `  ${r.ended.slice(0, 16)}  ${pad(proj(r.project), 32)} ${rpad(usd(r.cost || 0), 7)}  ${models}\n`;
  }
}

process.stdout.write(out);
