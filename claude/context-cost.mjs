#!/usr/bin/env node
// Claude Code, UserPromptSubmit: предупредить, когда сессия стала дорогой.
//
// Считать надо не то, что кажется дорогим, а то, что дорого по счёту. В
// замерах за 30 дней у Opus 5 вышло 61 МТокен чтения кеша против 204 КТокенов
// вывода: чтение контекста дало ~63% суммы, генерация ~10%. Значит цену турна
// определяет не сложность вопроса и не модель, а объём накопленного контекста,
// который перечитывается на каждом ходу.
//
// Отсюда и предупреждение: не «возьми модель дешевле» (переключение модели
// сбрасывает кеш и на длинном контексте стоит дороже, чем экономит), а
// «контекст вырос — следующая несвязанная задача дешевле с чистого листа».
//
// Порог берётся из последнего ответа ассистента в транскрипте: там лежит
// фактическое cache_read_input_tokens, а не оценка.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { handoffPath } from '../handoff-core.mjs';

const HOME = process.env.HOME || os.homedir();
const STATE_DIR = path.join(HOME, '.claude', 'state', 'context-cost');

// Цена чтения кеша за миллион токенов по моделям. Нужна, чтобы говорить
// деньгами, а не токенами: «300 КТокенов» ничего не значит, «$0.15 за ход» — да.
const CACHE_READ_PRICE = {
  'claude-fable-5-1': 0.25,
  'claude-fable-5': 1,
  'claude-opus-5': 0.5,
  'claude-opus-4-8': 0.5,
  'claude-sonnet-5': 0.2,
  'claude-sonnet-4-6': 0.3,
  'claude-haiku-4-5': 0.1,
};

// Ниже этого молчим: обычная рабочая сессия и должна держать контекст.
//
// Порог низкий намеренно. Цена хода — это весь контекст целиком, поэтому
// разница между «сказать на 80 КТокенах» и «сказать на 200» не в громкости
// совета, а в том, что сотня ходов между этими точками уже оплачена по
// втрое большей ставке. Предупреждать надо там, где ещё есть что спасать.
const WARN_TOKENS = Number(process.env.CONTEXT_COST_WARN || 80_000);
// Второй порог — когда пора не советовать, а настаивать.
const LOUD_TOKENS = Number(process.env.CONTEXT_COST_LOUD || 200_000);
// Не чаще раза в N ходов на сессию, иначе подсказка станет фоном.
const REMIND_EVERY = 12;

function lastUsage(transcriptPath) {
  let text;
  try { text = fs.readFileSync(transcriptPath, 'utf8'); } catch { return null; }
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i]) continue;
    let rec;
    try { rec = JSON.parse(lines[i]); } catch { continue; }
    if (rec.type !== 'assistant' || !rec.message?.usage) continue;
    return { usage: rec.message.usage, model: rec.message.model || '' };
  }
  return null;
}

function priceFor(model) {
  const key = Object.keys(CACHE_READ_PRICE).find((k) => String(model).startsWith(k));
  return key ? CACHE_READ_PRICE[key] : null;
}

// Счётчик ходов с последнего напоминания — файл на сессию.
function shouldSpeak(sessionId) {
  const file = path.join(STATE_DIR, String(sessionId).replace(/[^\w-]/g, '').slice(0, 80));
  let count = 0;
  try { count = Number(fs.readFileSync(file, 'utf8')) || 0; } catch { /* первое обращение */ }
  const speak = count <= 0;
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.writeFileSync(file, String(speak ? REMIND_EVERY : count - 1));
  } catch { /* без счётчика скажем ещё раз — не страшно */ }
  return speak;
}

export function contextCostNote({ transcript_path, session_id, cwd }) {
  const last = lastUsage(transcript_path);
  if (!last) return null;

  const cacheRead = last.usage.cache_read_input_tokens || 0;
  if (cacheRead < WARN_TOKENS) return null;
  if (!shouldSpeak(session_id)) return null;

  const price = priceFor(last.model);
  const perTurn = price ? `≈ $${((cacheRead / 1e6) * price).toFixed(2)} за ход` : `${Math.round(cacheRead / 1000)} КТокенов за ход`;
  const loud = cacheRead >= LOUD_TOKENS;
  const file = handoffPath(cwd);

  return loud
    ? `Контекст сессии ${Math.round(cacheRead / 1000)} КТокенов, перечитывается целиком на каждом ходу (${perTurn}). ` +
      `Пора закрывать сессию: запиши передачу в ${file} (состояние, открытые вопросы, следующий шаг) и предложи \`/clear\` — ` +
      'на старте она подставится обратно. ' +
      'Менять модель на ходу смысла нет: кеш привязан к модели, и возврат обойдётся дороже экономии.'
    : `Контекст сессии вырос до ${Math.round(cacheRead / 1000)} КТокенов (${perTurn}). ` +
      `Для несвязанной задачи дешевле начать с \`/clear\`, записав передачу в ${file}.`;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  let raw = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (c) => { raw += c; });
  process.stdin.on('end', () => {
    try {
      const note = contextCostNote(JSON.parse(raw));
      if (note) process.stdout.write(JSON.stringify({ systemMessage: note }));
    } catch { /* подсказка не должна ломать промпт */ }
    process.exit(0);
  });
}
