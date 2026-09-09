// Замер занятости контекстного окна и пороги перехода в новую сессию.
//
// Считать нечего: в каждой записи ассистента Claude Code хранит usage запроса, и
// input + cache_read + cache_write — это ровно то, что модель прочитала в этот
// ход, то есть текущая занятость окна. Нужна только последняя такая запись.
//
// Читаем хвост файла, а не файл: транскрипт длинной сессии — мегабайты, а замер
// зовётся на каждый промпт и на каждую отрисовку статусной строки.
//
// Модуль чистый — без stdin и вывода: его импортируют и хук, и statusline.

import fs from 'node:fs';
import { statePath, readJSON, writeJSON } from './state-core.mjs';

// Окно всех текущих моделей Claude Code. Переопределяется через env, если
// включён длинный контекст: цифра нужна только как знаменатель процента.
export const WINDOW = Number(process.env.AI_HOOKS_CONTEXT_WINDOW) || 200_000;

// 60% — задачу ещё можно довести до границы и уйти на своих условиях.
// 75% — уходить сейчас: дальше каждый ход оплачивает чтение всего накопленного,
// а запас до автокомпакта нужен, чтобы передачу успел написать я, а не он.
export const WARN = 0.6;
export const ACT = 0.75;

// Напоминание об экономии контекста само лежит в контексте, поэтому повторяем
// его не чаще, чем на каждые +5 п.п. роста.
const REPEAT_STEP = 5;

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

export function level(pct) {
  if (pct >= ACT * 100) return 'act';
  if (pct >= WARN * 100) return 'warn';
  return null;
}

// Состояние — только чтобы не повторяться. Записи чужих сессий старше суток
// выбрасываем: файл не журнал, а память одного дня.
function announced(sessionId) {
  const all = readJSON(STATE_FILE);
  const rec = all[sessionId];
  return rec && typeof rec.pct === 'number' ? rec.pct : null;
}

function remember(sessionId, pct) {
  const now = Date.now();
  const all = readJSON(STATE_FILE);
  for (const [key, rec] of Object.entries(all)) {
    if (!rec || typeof rec.at !== 'number' || now - rec.at > KEEP_MS) delete all[key];
  }
  all[sessionId] = { pct, at: now };
  writeJSON(STATE_FILE, all);
}

export function noticeText(lvl, pct) {
  if (lvl === 'warn') {
    return `Контекст занят на ${pct}% при пороге передачи 75%. Доводи текущую единицу работы `
      + 'до коммита и не начинай новую крупную линию рассуждений: скоро уходим в новую сессию. '
      + 'Пользователю об этом сообщать не нужно — это указание тебе.';
  }
  return `Контекст занят на ${pct}% — пора передавать. Закоммить текущую единицу работы, `
    + 'загрузи скилл `handoff`, запиши по нему файл передачи и одной строкой позови '
    + 'пользователя нажать `/clear`. Новая сессия получит файл сама. Если правка не доведена '
    + 'до состояния, которое не стыдно бросить, — сначала доведи её, потом передавай.';
}

// null — молчим. Иначе уровень, процент и текст для additionalContext.
export function contextNotice(input) {
  const used = contextUsed(input?.transcript_path);
  if (!used) return null;
  const lvl = level(used.pct);
  if (!lvl) return null;

  const sessionId = input?.session_id;
  if (sessionId) {
    const prev = announced(sessionId);
    // Переход warn → act объявляем сразу, даже если рост меньше шага: это смена
    // требования, а не ещё пять процентов.
    const crossedIntoAct = lvl === 'act' && prev !== null && prev < ACT * 100;
    if (prev !== null && !crossedIntoAct && used.pct < prev + REPEAT_STEP) return null;
    remember(sessionId, used.pct);
  }

  return { level: lvl, pct: used.pct, tokens: used.tokens, text: noticeText(lvl, used.pct) };
}
