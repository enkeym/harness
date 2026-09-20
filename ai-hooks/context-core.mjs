// Замер занятости контекстного окна и пороги, на которых агенту пора закрывать
// шаг и уходить в новую сессию.
//
// Считать нечего: в каждой записи ассистента Claude Code хранит usage запроса, и
// input + cache_read + cache_write + output — это ровно то, что модель прочитала
// и произвела в этот ход, то есть текущая занятость окна. Нужна только последняя
// такая запись основной нити.
//
// Читаем хвост файла, а не файл: транскрипт длинной сессии — мегабайты, а замер
// зовётся на каждый промпт и на каждую отрисовку статусной строки.
//
// Пороги заданы В ТОКЕНАХ, а не в долях окна. С включённым 1M-окном процент
// перестал что-либо значить для расхода: платим не за долю окна, а за токены, и
// 96% месячного счёта — это cache read, то есть перечитывание накопленного на
// каждом ходе. Цена одного хода по локальному ledger'у растёт с $0.046 в коротких
// сессиях до $0.136 в сессиях за сотню ходов — втрое, задолго до любого предела
// окна. Отсюда SOFT/HAND/HARD ниже: это бюджет, а не вместимость.
//
// Файлов передача не создаёт и `/clear` не зовёт. На пороге агент выдаёт
// markdown-блок состояния прямо в чат; пользователь переносит его руками.
//
// Модуль чистый — без stdin и вывода: его импортируют и хук, и statusline.

import fs from 'node:fs';
import { statePath, readJSON, writeJSON } from './state-core.mjs';

// Знаменатель процента в статусной строке. 1M — окно моделей с длинным
// контекстом; переопределяется через env для окна поменьше. На пороги не влияет.
export const WINDOW = Number(process.env.AI_HOOKS_CONTEXT_WINDOW) || 1_000_000;

const num = (env, fallback) => Number(process.env[env]) || fallback;

// SOFT — шаг пора закрывать: дальше каждый новый ход оплачивает всё накопленное.
// HAND — собрать блок передачи после ближайшего коммита.
// HARD — работать здесь уже дорого; напоминание повторяется каждый ход.
export const SOFT = num('AI_HOOKS_CTX_SOFT', 90_000);
export const HAND = num('AI_HOOKS_CTX_HAND', 150_000);
export const HARD = num('AI_HOOKS_CTX_HARD', 220_000);

const TAIL_BYTES = 256 * 1024;
const STATE_FILE = statePath('context-meter.json');
const KEEP_MS = 24 * 3600 * 1000;

// Порядок порогов: объявленный порог гасит только равные и младшие.
const RANK = { soft: 1, hand: 2, hard: 3 };

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

// Порог, на котором стоит сессия: null | 'soft' | 'hand' | 'hard'. Принимает
// токены — не проценты: у индикатора и у текста агенту одна шкала.
export function level(tokens) {
  if (!Number.isFinite(tokens) || tokens < SOFT) return null;
  if (tokens >= HARD) return 'hard';
  if (tokens >= HAND) return 'hand';
  return 'soft';
}

// Что объявляли этой сессии. Записи чужих сессий старше суток выбрасываем:
// файл не журнал, а память одного дня.
function announced(sessionId) {
  const rec = readJSON(STATE_FILE)[sessionId];
  return rec?.stage || null;
}

function remember(sessionId, stage) {
  const now = Date.now();
  const all = readJSON(STATE_FILE);
  for (const [key, rec] of Object.entries(all)) {
    if (!rec || typeof rec.at !== 'number' || now - rec.at > KEEP_MS) delete all[key];
  }
  all[sessionId] = { stage, at: now };
  writeJSON(STATE_FILE, all);
}

const k = (tokens) => `${Math.round(tokens / 1000)}k`;

export function noticeText(stage, tokens, sessionId) {
  const size = `В контексте ${k(tokens)} токенов.`;

  if (stage === 'soft') {
    return `${size} Каждый следующий ход заново оплачивает всё накопленное, поэтому крупное `
      + 'сюда уже не влезает дёшево: доведи текущий шаг до коммита и не начинай в этой сессии '
      + 'новый. Файлы целиком не перечитывай — бери символ или диапазон. Блок передачи пока не '
      + 'собирай, про порог пользователю не сообщай: это указание тебе, и на этом пороге оно '
      + 'единственное.';
  }

  const resume = sessionId
    ? ` История этой сессии остаётся доступной через \`claude --resume ${sessionId}\`.`
    : '';

  if (stage === 'hand') {
    return `${size} Доведи текущую единицу работы до состояния, которое не стыдно бросить `
      + '(коммит), и собери блок передачи по скиллу `handoff` — одним markdown-блоком прямо в '
      + 'чат, для ручного копирования. Файлов не создавай, очистку контекста не предлагай и сам '
      + `не запускай: пользователь перенесёт блок в новую сессию сам.${resume} Про сам порог `
      + 'пользователю не сообщай, это указание тебе.';
  }

  return `${size} Это уже дорогая зона: ход здесь стоит втрое против начала сессии. Новую работу `
    + 'не начинай, глубокие чтения и обзоры не запускай — закрой начатое коммитом и выдай блок '
    + `передачи по скиллу \`handoff\` прямо в чат.${resume} Напоминание будет повторяться каждый `
    + 'ход, пока сессия не сменится; пользователю про порог не сообщай.';
}

// null — молчим. Иначе порог, занятость и текст для additionalContext.
//
// Один раз на порог: soft не повторяется, hand звучит поверх soft, а hard —
// каждый ход, потому что именно там прежняя версия замолкала навсегда и сессия
// спокойно уезжала за 300k.
export function contextNotice(input) {
  const used = contextUsed(input?.transcript_path);
  if (!used) return null;

  const stage = level(used.tokens);
  if (!stage) return null;

  const sessionId = input?.session_id;
  if (sessionId && stage !== 'hard') {
    const seen = announced(sessionId);
    if (seen && RANK[seen] >= RANK[stage]) return null;
  }
  if (sessionId) remember(sessionId, stage);

  return {
    stage,
    pct: used.pct,
    tokens: used.tokens,
    text: noticeText(stage, used.tokens, sessionId),
  };
}
