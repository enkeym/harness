// Журнал решений хуков — logs/hooks.jsonl. До него след «модель спотыкается»
// нигде не собирался целиком: errors.log знает падения фоновых задач, а сами
// запреты (ask-guard, security, bash-router), их причины и время работы хука
// не писались никуда. /doctor по такому набору не мог восстановить
// последовательность «запрет → что модель попробовала дальше → снова запрет».
//
// Пишутся только РЕШЕНИЯ, не вызовы: deny/ask, падение самого хука и
// медленный проход (> SLOW_MS) — в норме файл почти не растёт. session_id есть
// в каждой записи, чтобы разбирать одну сессию, а не хвост общего журнала.
//
// Модуль чистый и без зависимостей от формата хука: контекст (сессия, имя
// хука, инструмент) выставляет hook-io при разборе stdin.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { performance } from 'node:perf_hooks';

const HOME = process.env.HOME || os.homedir();
const LOG_DIR = process.env.AI_HOOKS_LOG_DIR || path.join(HOME, '.ai-hooks', 'logs');

export const HOOKS_LOG = process.env.AI_HOOKS_HOOKS_LOG || path.join(LOG_DIR, 'hooks.jsonl');
const ERRORS_LOG = path.join(LOG_DIR, 'errors.log');

// Медленный хук ощущается как «спотыкание» не хуже запрещающего, но до этого
// журнала его не видел никто. Порог с запасом над штатным стартом node +
// sqlite-запросом гарда.
export const SLOW_MS = 800;

const REASON_MAX = 160;
const TARGET_MAX = 200;

// target запрета — это команда или путь, и у security-guard в команде может
// стоять токен (`curl -H "Authorization: Bearer …"`, `TOKEN=… node …`).
// Для разбора цикла важно, ЧТО повторялось, а не значение секрета — значения
// маскируются до записи.
const SECRET_PATTERNS = [
  [/\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, '$1 ***'],
  [/\b((?:[A-Za-z_][A-Za-z0-9_-]*)?(?:token|secret|password|passwd|api[_-]?key|private[_-]?key|authorization))\s*[=:]\s*["']?[^\s"']{4,}/gi, '$1=***'],
  [/(\s(?:-u|--user|--password|--token)[\s=]+)[^\s"']+/g, '$1***'],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}/g, '***'],
  [/\b(?:sk_(?:live|test)_[A-Za-z0-9]{8,}|ghp_[A-Za-z0-9]{20,}|xox[abprs]-[A-Za-z0-9-]{10,}|AKIA[A-Z0-9]{16})\b/g, '***'],
  [/(:\/\/[^\s/:@]+:)[^\s@/]+@/g, '$1***@'],
];

export function redact(text) {
  return SECRET_PATTERNS.reduce((out, [re, sub]) => out.replace(re, sub), String(text ?? ''));
}

let ctx = { sid: null, hook: null, tool: null, cwd: null };

function hookName() {
  return path.basename(process.argv[1] || '', '.mjs') || null;
}

// Зовётся один раз из readInput; всё, что пишется дальше в этом процессе,
// получает сессию и инструмент отсюда.
export function setHookContext(input, hook = null) {
  ctx = {
    sid: input?.session_id || null,
    hook: hook || hookName(),
    tool: input?.tool_name || null,
    cwd: input?.cwd || null,
  };
}

export function hookContext() {
  return ctx;
}

// Миллисекунды с момента старта процесса — это и есть то, сколько хук стоил
// вызову: старт node входит в ожидание модели так же, как сама проверка.
export function elapsedMs() {
  return Math.round(performance.now());
}

function trimText(value, max) {
  return redact(String(value ?? '').replace(/\s+/g, ' ').trim()).slice(0, max);
}

// decision: deny | ask | slow | crash.
// Журнал не обязан работать, чтобы работал хук — любая ошибка глотается.
export function logDecision(decision, data = {}) {
  try {
    const rec = {
      ts: new Date().toISOString(),
      sid: ctx.sid,
      hook: ctx.hook || hookName(),
      tool: ctx.tool,
      decision,
      ms: elapsedMs(),
      ...data,
    };
    if (rec.reason !== undefined) rec.reason = trimText(rec.reason, REASON_MAX);
    if (rec.target !== undefined) rec.target = trimText(rec.target, TARGET_MAX);
    fs.mkdirSync(path.dirname(HOOKS_LOG), { recursive: true });
    fs.appendFileSync(HOOKS_LOG, JSON.stringify(rec) + '\n');
    return true;
  } catch {
    return false;
  }
}

// Разрешённый вызов в журнал не попадает — кроме случая, когда сам хук
// работал дольше порога.
export function logSlowIfNeeded(data = {}) {
  if (elapsedMs() <= SLOW_MS) return false;
  return logDecision('slow', data);
}

function localStamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
    `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

// Падение самого хука. До этого исключение внутри cb просто роняло процесс с
// ненулевым кодом: Claude показывал «hook error» и шёл дальше, а причина не
// оставалась нигде. Пишем в оба журнала: строку решения — чтобы падение было
// видно в последовательности сессии, и стек в errors.log — в том же формате,
// что log-error.sh, чтобы /doctor читал один файл.
export function logCrash(err, input = null) {
  if (input) setHookContext(input);
  logDecision('crash', { error: trimText(err?.message || err, 300) });
  try {
    const stack = String(err?.stack || err)
      .split('\n')
      .slice(0, 12)
      .map((l) => '    ' + l.slice(0, 200))
      .join('\n');
    fs.mkdirSync(LOG_DIR, { recursive: true });
    fs.appendFileSync(
      ERRORS_LOG,
      `[${localStamp()}] hook ${ctx.hook || hookName()} | ${ctx.cwd || '?'} | exit=crash\n${stack}\n---\n`,
    );
  } catch {
    // errors.log недоступен — запись в hooks.jsonl уже сделана
  }
}

// Последние записи журнала — для напоминаний и /doctor. Битые строки
// пропускаются. Нет файла → [].
export function readRecent(limit = 200) {
  try {
    const lines = fs.readFileSync(HOOKS_LOG, 'utf8').trim().split('\n').slice(-limit);
    const out = [];
    for (const line of lines) {
      try { out.push(JSON.parse(line)); } catch { /* обрезанная строка */ }
    }
    return out;
  } catch {
    return [];
  }
}
