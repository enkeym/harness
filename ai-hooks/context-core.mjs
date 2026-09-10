// Замер занятости контекстного окна и единственный порог: сказать агенту
// один раз собрать блок передачи прямо в чат.
//
// Считать нечего: в каждой записи ассистента Claude Code хранит usage запроса, и
// input + cache_read + cache_write + output — это ровно то, что модель прочитала
// и произвела в этот ход, то есть текущая занятость окна. Нужна только последняя
// такая запись основной нити.
//
// Читаем хвост файла, а не файл: транскрипт длинной сессии — мегабайты, а замер
// зовётся на каждый промпт и на каждую отрисовку статусной строки.
//
// Файлов передача больше не создаёт и `/clear` не зовёт. На пороге агент один
// раз выдаёт markdown-блок состояния прямо в чат; пользователь переносит его
// руками в новую сессию, если хочет продолжить, — иначе просто очищает контекст.
// После единственного срабатывания хук молчит до конца сессии.
//
// Модуль чистый — без stdin и вывода: его импортируют и хук, и statusline.

import fs from 'node:fs';
import { statePath, readJSON, writeJSON } from './state-core.mjs';

// Окно всех текущих моделей Claude Code. Переопределяется через env, если
// включён длинный контекст: цифра нужна только как знаменатель процента.
export const WINDOW = Number(process.env.AI_HOOKS_CONTEXT_WINDOW) || 200_000;

// 75% — уходить пора: дальше каждый ход оплачивает чтение всего накопленного,
// а запас до автокомпакта (~95%) нужен, чтобы блок успел собрать я, а не он.
export const ACT = 0.75;
// Индикатор в статусной строке желтеет раньше — чтобы рост окна был виден
// глазами до того, как хук что-то скажет. Это только цвет, не текст в контексте.
export const WARN = 0.6;

const TAIL_BYTES = 256 * 1024;
const STATE_FILE = statePath('context-meter.json');
const KEEP_MS = 24 * 3600 * 1000;

// Последние TAIL_BYTES файла. При обрезке первая строка почти наверняка
// неполная — её и отбрасываем, разбор всё равно упал бы на ней.
function readTail(file) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const { size } = fs.fstatSync(fd);
    const from = Math.max(0, size - TAIL_BYTES);
    const buf = Buffer.alloc(size - from);
    fs.readSync(fd, buf, 0, buf.length, from);
    const text = buf.toString('utf8');
    if (from === 0) return text;
    const nl = text.indexOf('\n');
    return nl === -1 ? '' : text.slice(nl + 1);
  } catch {
    return '';
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch { /* уже закрыт */ }
    }
  }
}

// Занятость окна по последней записи ассистента основной нити.
//
// Субагенты (isSidechain) считают свой контекст, не наш: сразу после агента их
// запись лежит последней и дала бы заниженную цифру — как раз там, где контекст
// вырос сильнее всего.
export function contextUsed(transcriptPath) {
  if (!transcriptPath) return null;
  const lines = readTail(transcriptPath).split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i]) continue;
    let rec;
    try { rec = JSON.parse(lines[i]); } catch { continue; }
    if (rec.type !== 'assistant' || rec.isSidechain || !rec.message?.usage) continue;
    const u = rec.message.usage;
    const tokens = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0)
      + (u.cache_creation_input_tokens || 0) + (u.output_tokens || 0);
    if (!tokens) continue;
    return { tokens, pct: Math.round((tokens / WINDOW) * 100), model: rec.message.model || null };
  }
  return null;
}

// Для цвета индикатора статусной строки: null | 'warn' | 'act'. Текстовое
// предупреждение агенту завязано только на 'act'.
export function level(pct) {
  if (pct >= ACT * 100) return 'act';
  if (pct >= WARN * 100) return 'warn';
  return null;
}

// Одно срабатывание на сессию. Состояние — только чтобы не повторяться; записи
// чужих сессий старше суток выбрасываем: файл не журнал, а память одного дня.
function announced(sessionId) {
  const all = readJSON(STATE_FILE);
  return Boolean(all[sessionId]?.done);
}

function remember(sessionId) {
  const now = Date.now();
  const all = readJSON(STATE_FILE);
  for (const [key, rec] of Object.entries(all)) {
    if (!rec || typeof rec.at !== 'number' || now - rec.at > KEEP_MS) delete all[key];
  }
  all[sessionId] = { done: true, at: now };
  writeJSON(STATE_FILE, all);
}

export function noticeText(pct, sessionId) {
  const resume = sessionId
    ? ` История этой сессии остаётся доступной через \`claude --resume ${sessionId}\`.`
    : '';
  return `Контекст занят на ${pct}%. Собери блок передачи по скиллу \`handoff\` и выдай его `
    + 'прямо в чат одним markdown-блоком для ручного копирования. Файлов не создавай, очистку '
    + 'контекста не предлагай и сам не запускай: пользователь либо перенесёт блок в новую сессию '
    + `руками, либо просто сбросит контекст сам.${resume} Это единственное напоминание — дальше `
    + 'про занятость контекста молчи до конца сессии, даже если она вырастет. Пользователю про '
    + 'сам порог сообщать не нужно, это указание тебе. Сначала доведи текущую единицу работы до '
    + 'состояния, которое не стыдно бросить (коммит), потом собирай блок.';
}

// null — молчим. Иначе процент, токены и текст для additionalContext.
export function contextNotice(input) {
  const used = contextUsed(input?.transcript_path);
  if (!used || used.pct < ACT * 100) return null;

  const sessionId = input?.session_id;
  if (sessionId) {
    if (announced(sessionId)) return null;
    remember(sessionId);
  }

  return { pct: used.pct, tokens: used.tokens, text: noticeText(used.pct, sessionId) };
}
