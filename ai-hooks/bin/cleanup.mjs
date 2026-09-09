#!/usr/bin/env node
// Уборка следов работы агента: метки состояния, журналы, кеши.
//
//   cleanup.mjs            — прибраться (не чаще раза в сутки)
//   cleanup.mjs --force    — прибраться сейчас, игнорируя дроссель
//   cleanup.mjs --dry-run  — показать, что удалилось бы
//
// Вешается на Stop и потому обязан быть дешёвым: дроссель по метке времени
// делает проход раз в сутки, всё остальное — обход нескольких каталогов.
//
// Что здесь НЕ чистится и почему: транскрипты (~/.claude/projects) — ими
// управляет сам Claude Code через cleanupPeriodDays, и удалить их значит
// потерять возможность вернуться в сессию; file-history — на нём держится отмена
// правок; индексы .tokensave/.ragsave — их чистят собственные GC, а внешнее
// удаление стоит переиндексации.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { STATE_ROOT, statePath } from '../state-core.mjs';

const HOME = process.env.HOME || os.homedir();
const STAMP = statePath('.cleanup-stamp');
const THROTTLE_MS = 24 * 3600 * 1000;
const DAY = 86400 * 1000;

// Каталог, срок жизни файла в сутках, за что отвечает.
const TARGETS = [
  // Метка «подсказку про rag_search в этой сессии уже показывали». Дроссель
  // внутри — 15 минут, так что метка старше суток мертва по определению.
  [statePath('ragsave-reminder'), 2, 'метки подсказок ragsave'],
  // Метка «про недостающий CI этому проекту уже говорили» — недельный цикл.
  [statePath('bootstrap'), 90, 'метки диагностики проектов'],
  // Метки режима ask mode по каталогам (dir-<hash>). Файла `default` в этом
  // каталоге нет — он лежит в подкаталоге ask-mode/, а pruneDir не рекурсивен,
  // так что бессрочная метка режима по умолчанию не пострадает.
  [statePath('ask-mode'), 120, 'метки ask mode по каталогам'],
  // Счётчик ходов до следующей подсказки о стоимости — живёт внутри сессии.
  [statePath('context-cost'), 2, 'счётчики стоимости контекста'],
  // Служебные метки в корне состояния: guard-breaker.json (сам себя чистит за
  // 3 мин), cli-health.json (перепроверяется), временные codex-last-* от
  // делегирования. Всё пересоздаётся; .cleanup-stamp свежий по определению.
  [STATE_ROOT, 7, 'служебные метки состояния'],
  // Неотправленная телеметрия Claude Code: если её не приняли за неделю, не примут.
  [path.join(HOME, '.claude', 'telemetry'), 7, 'неотправленная телеметрия'],
  // Содержимое вставок в промпт — нужно только внутри своей сессии.
  [path.join(HOME, '.claude', 'paste-cache'), 14, 'кеш вставок'],
  // Снимки окружения и shell по сессиям — мертвы вместе с сессией.
  [path.join(HOME, '.claude', 'session-env'), 30, 'окружение сессий'],
  [path.join(HOME, '.claude', 'shell-snapshots'), 7, 'снимки shell'],
  // Полные выводы обрезанных команд. Срок короткий не ради места: вывод сборки
  // или compose-конфига может содержать секрет, а здесь он лежал бы открытым
  // текстом дольше, чем сам транскрипт (cleanupPeriodDays: 45).
  [statePath('clip-output'), 2, 'полные выводы команд'],
  // Передачи между сессиями. Старше двух недель уже не подставляются
  // (handoff-core.mjs), но продолжают лежать — а это состояние работы.
  [path.join(HOME, '.claude', 'handoff'), 30, 'передачи между сессиями'],
];

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const force = args.includes('--force') || dryRun;

function throttled() {
  try {
    return Date.now() - fs.statSync(STAMP).mtimeMs < THROTTLE_MS;
  } catch {
    return false;
  }
}

function stamp() {
  try {
    fs.mkdirSync(path.dirname(STAMP), { recursive: true });
    fs.writeFileSync(STAMP, new Date().toISOString());
  } catch { /* без метки просто уберёмся ещё раз */ }
}

function pruneDir(dir, maxAgeDays) {
  let files = 0;
  let bytes = 0;
  const cutoff = Date.now() - maxAgeDays * DAY;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return { files, bytes }; }
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const file = path.join(dir, entry.name);
    try {
      const st = fs.statSync(file);
      if (st.mtimeMs >= cutoff) continue;
      if (!dryRun) fs.unlinkSync(file);
      files += 1;
      bytes += st.size;
    } catch { /* исчез сам — не наша забота */ }
  }
  return { files, bytes };
}

// Журнал расходов: подробности нужны недолго, суммы — всегда. Записи старше
// порога сворачиваются в одну строку на месяц, и файл перестаёт расти линейно
// по числу сессий, не теряя картину за год.
function rollupUsage(keepDays = 90) {
  const file = path.join(HOME, '.ai-hooks', 'logs', 'usage.jsonl');
  let lines;
  try { lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean); } catch { return null; }

  const cutoff = Date.now() - keepDays * DAY;
  const fresh = [];
  const months = new Map();
  // Считаем именно свёрнутые записи, а не разницу в длине файла. Две старые
  // сессии из разных месяцев дают две месячные строки — длина не меняется, но
  // подробности уже отброшены, и результат обязан быть записан. Гейт по длине
  // молча выбрасывал такую свёртку, и файл рос дальше.
  let converted = 0;

  for (const line of lines) {
    let rec;
    try { rec = JSON.parse(line); } catch { continue; }
    if (rec.rollup) { months.set(rec.rollup, mergeRollup(months.get(rec.rollup), rec)); continue; }
    const when = new Date(rec.ended || rec.updated || 0).getTime();
    if (!when || when >= cutoff) { fresh.push(rec); continue; }
    const key = new Date(when).toISOString().slice(0, 7);
    months.set(key, mergeRollup(months.get(key), toRollup(key, rec)));
    converted += 1;
  }

  const out = [...months.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([, v]) => v).concat(fresh);
  if (converted > 0 && !dryRun) {
    fs.writeFileSync(file, out.map((r) => JSON.stringify(r)).join('\n') + '\n');
  }
  return { collapsed: converted, kept: out.length };
}

function toRollup(key, rec) {
  const models = {};
  for (const [name, m] of Object.entries(rec.models || {})) {
    models[name] = {
      input: m.input || 0,
      cacheRead: m.cacheRead || 0,
      cacheWrite: (m.cacheWrite5m || 0) + (m.cacheWrite1h || 0),
      output: m.output || 0,
      cost: m.cost || 0,
    };
  }
  return { rollup: key, sessions: 1, subagents: rec.subagents || 0, cost: rec.cost || 0, models };
}

function mergeRollup(acc, next) {
  if (!acc) return next;
  const models = { ...acc.models };
  for (const [name, m] of Object.entries(next.models || {})) {
    const cur = models[name] || { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, cost: 0 };
    models[name] = {
      input: cur.input + (m.input || 0),
      cacheRead: cur.cacheRead + (m.cacheRead || 0),
      cacheWrite: cur.cacheWrite + (m.cacheWrite || 0),
      output: cur.output + (m.output || 0),
      cost: Math.round((cur.cost + (m.cost || 0)) * 10000) / 10000,
    };
  }
  return {
    rollup: acc.rollup,
    sessions: acc.sessions + (next.sessions || 1),
    subagents: acc.subagents + (next.subagents || 0),
    cost: Math.round((acc.cost + (next.cost || 0)) * 10000) / 10000,
    models,
  };
}

// Журнал отказов фоновых задач: обрезаем хвостом, а не целиком — последние
// записи и есть то, ради чего в него смотрят.
function trimLog(maxBytes = 2 * 1024 * 1024, keepLines = 500) {
  const file = path.join(HOME, '.ai-hooks', 'logs', 'errors.log');
  try {
    if (fs.statSync(file).size <= maxBytes) return 0;
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    const dropped = Math.max(0, lines.length - keepLines);
    if (dropped && !dryRun) fs.writeFileSync(file, lines.slice(-keepLines).join('\n'));
    return dropped;
  } catch {
    return 0;
  }
}

function human(bytes) {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} МБ`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)} КБ`;
  return `${bytes} Б`;
}

if (!force && throttled()) process.exit(0);

const report = [];
let totalFiles = 0;
let totalBytes = 0;
for (const [dir, days, label] of TARGETS) {
  const { files, bytes } = pruneDir(dir, days);
  if (files) report.push(`${label}: ${files} файлов, ${human(bytes)}`);
  totalFiles += files;
  totalBytes += bytes;
}

const usage = rollupUsage();
if (usage?.collapsed) report.push(`журнал расходов: свёрнуто ${usage.collapsed} записей, осталось ${usage.kept}`);
const droppedLines = trimLog();
if (droppedLines) report.push(`журнал отказов: обрезано ${droppedLines} строк`);

if (!dryRun) stamp();

if (report.length) {
  const head = dryRun ? 'Удалилось бы' : `Убрано ${totalFiles} файлов, ${human(totalBytes)}`;
  process.stdout.write(`${head}:\n  ${report.join('\n  ')}\n`);
} else if (args.length) {
  process.stdout.write('Чистить нечего.\n');
}
