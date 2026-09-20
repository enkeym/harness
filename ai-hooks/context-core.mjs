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
// Замер живёт в двух фазах. 'prompt' — на ходу пользователя, где ничего ещё не
// начато. 'step' — между вызовами инструментов внутри одного хода: автономный ход
// на сотню вызовов проходит все три порога, ни разу не вернувшись к пользователю, и
// без этой фазы пороги для него не существуют. Требования разные: посреди хода
// нельзя бросить ответ на половине — сначала коммит и пуш, потом блок передачи.
//
// Модуль чистый — без stdin и вывода: его импортируют оба хука и statusline.

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

// На сколько должен вырасти контекст, чтобы верхний порог прозвучал посреди хода
// ещё раз. На ходу пользователя мерой повтора служит сам ход; внутри хода ходов
// нет, а вызовов инструментов сотни — привязка к их числу превратила бы
// напоминание в шум на каждом вызове.
export const STEP_REPEAT = num('AI_HOOKS_CTX_STEP_REPEAT', 20_000);

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

// Память о сессии: какой порог объявлен, на какой занятости это было и появилась
// ли в сессии работа. Записи старше суток выбрасываем: файл не журнал, а память
// одного дня.
function record(sessionId) {
  return readJSON(STATE_FILE)[sessionId] || null;
}

function update(sessionId, patch) {
  const now = Date.now();
  const all = readJSON(STATE_FILE);
  for (const [key, rec] of Object.entries(all)) {
    if (!rec || typeof rec.at !== 'number' || now - rec.at > KEEP_MS) delete all[key];
  }
  all[sessionId] = { ...all[sessionId], ...patch, at: now };
  writeJSON(STATE_FILE, all);
}

// Инструменты, после которых в сессии есть что передавать: правка файла или
// коммит. Чтение и поиск сюда не входят намеренно — ими порог как раз и берётся.
const EDIT_TOOL = /^(Edit|Write|MultiEdit|NotebookEdit)$/;
const EDIT_MCP = /(str_replace|insert_at|replace_symbol)/;

function isWork(toolName, toolInput) {
  if (!toolName) return false;
  if (EDIT_TOOL.test(toolName) || EDIT_MCP.test(toolName)) return true;
  if (toolName === 'Bash') return /\bgit\s+commit\b/.test(String(toolInput?.command || ''));
  return false;
}

// Отметка «в сессии появилась работа». Пишется один раз за сессию: дальше запись
// уже стоит, и файл на каждом вызове инструмента не трогаем.
export function noteWork(input) {
  const sessionId = input?.session_id;
  if (!sessionId || !isWork(input?.tool_name, input?.tool_input)) return false;
  if (record(sessionId)?.worked) return false;
  update(sessionId, { worked: true });
  return true;
}

// Объявленный порог звучит снова только наверху: на ходу пользователя — каждый
// ход, потому что именно там прежняя версия замолкала навсегда; посреди хода —
// когда контекст с прошлого раза вырос ещё на STEP_REPEAT.
function mayRepeat(phase, stage, tokens, seen) {
  if (stage !== 'hard' || seen.stage !== 'hard') return false;
  if (phase !== 'step') return true;
  return tokens - (seen.tokens || 0) >= STEP_REPEAT;
}

const k = (tokens) => `${Math.round(tokens / 1000)}k`;

// Текст посреди хода. Здесь агент уже что-то начал, и «остановись» оставило бы
// грязное рабочее дерево, а следующей сессии — не шаг, а половину шага, которую
// нечем описать в блоке передачи. Поэтому требование другое: довести текущий шаг
// до коммита с пушем и не начинать следующий — его сделает новая сессия.
function stepText(stage, size, resume) {
  const finish = 'Ответ на середине не обрывай: доведи текущий шаг до конца и закрой его '
    + 'коммитом и пушем по скиллу `git-flow`.';

  if (stage === 'soft') {
    return `${size} Порог пройден посреди хода. ${finish} Новый шаг в этой сессии не `
      + 'начинай, файлы целиком не перечитывай — бери символ или диапазон. Блок передачи '
      + 'пока не собирай, про порог пользователю не сообщай: это указание тебе.';
  }

  const handoff = 'Следующий шаг здесь не начинай: вместо него собери блок передачи по скиллу '
    + '`handoff` — одним markdown-блоком прямо в чат, и первым пунктом «Дальше» назови '
    + 'именно его. Файлов не создавай, очистку контекста не предлагай и сам не запускай: '
    + 'пользователь перенесёт блок в новую сессию сам.';

  if (stage === 'hand') {
    return `${size} Порог пройден посреди хода. ${finish} ${handoff}${resume} Про сам порог `
      + 'пользователю не сообщай, это указание тебе.';
  }

  return `${size} Это уже дорогая зона, и порог пройден посреди хода. ${finish} До конца `
    + 'шага ещё далеко — зафиксируй сделанное и честно назови незавершённое в блоке. '
    + `${handoff}${resume} Про сам порог пользователю не сообщай.`;
}

// Сессия, где ещё ничего не изменено. На первом пороге это одно чтение, и блок
// свёлся бы к списку прочитанного: новая сессия прочла бы то же самое и упёрлась
// в тот же порог — петля, а не передача. Требование здесь обратное: не
// останавливаться, а сузить чтение и дойти до результата. Без этой ветки сессия,
// где порог съедается одним сбором данных, вставала бы до начала работы.
//
// Выше первого порога сессия без правок — чаще всего уже не сбор данных перед
// правкой, а обсуждение: по транскриптам каждая седьмая сессия, дошедшая до
// SOFT, не сделала ни одной правки за всю жизнь и всё равно доехала до 200k+.
// Коммитить ей нечего, а её результат — выводы — терялся вместе с контекстом.
// Поэтому от HAND блок просят и здесь, но из выводов, не из прочитанного:
// список файлов — петля, список решений — передача.
function idleText(stage, size) {
  const narrow = 'Сузь чтение: символ или диапазон вместо файла целиком, поиск вместо '
    + 'обзора, прочитанное повторно не открывай.';

  if (stage === 'soft') {
    return `${size} Правок в этой сессии пока нет — значит платим за одно чтение. `
      + `${narrow} Работу при этом не откладывай и шаг не бросай: блок передачи сейчас `
      + 'бесполезен — в нём нечего передавать. Про порог пользователю не сообщай.';
  }

  const instead = 'Если сессия ведёт к правке — доведи до результата самый узкий полезный '
    + 'кусок и закрой его коммитом. Если её результат — выводы, а не правки, новых чтений '
    + 'не начинай: изложи выводы пользователю сейчас и собери блок передачи по скиллу '
    + '`handoff` из них — что выяснено, что отвергнуто и почему, что осталось. '
    + 'Прочитанное в блоке не перечисляй: новая сессия прочла бы то же самое и '
    + 'упёрлась в тот же порог.';

  if (stage === 'hand') return `${size} Правок в этой сессии всё ещё нет. ${narrow} ${instead}`;

  return `${size} Это дорогая зона, а правок в сессии нет. ${narrow} ${instead} Если `
    + 'задача не помещается даже в сбор данных, скажи об этом пользователю одной '
    + 'строкой: её нужно сузить, а не передавать.';
}

// phase: 'prompt' — на ходу пользователя, где ничего не начато; 'step' — посреди
// хода, между вызовами инструментов. worked — была ли в сессии работа,
// которую есть смысл передавать.
export function noticeText(stage, tokens, { sessionId, phase = 'prompt', worked = false } = {}) {
  const size = `В контексте ${k(tokens)} токенов.`;
  if (!worked) return idleText(stage, size);

  const resume = sessionId
    ? ` История этой сессии остаётся доступной через \`claude --resume ${sessionId}\`.`
    : '';

  if (phase === 'step') return stepText(stage, size, resume);

  if (stage === 'soft') {
    return `${size} Каждый следующий ход заново оплачивает всё накопленное, поэтому крупное `
      + 'сюда уже не влезает дёшево: доведи текущий шаг до коммита и не начинай в этой сессии '
      + 'новый. Файлы целиком не перечитывай — бери символ или диапазон. Блок передачи пока не '
      + 'собирай, про порог пользователю не сообщай: это указание тебе, и на этом пороге оно '
      + 'единственное.';
  }

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
//
// Леджер объявлений у фаз общий: порог, пройденный посреди хода, не повторяется
// следующим же промптом — указание уже доехало, и вторая копия была бы шумом.
export function contextNotice(input, { phase = 'prompt' } = {}) {
  const used = contextUsed(input?.transcript_path);
  if (!used) return null;

  const stage = level(used.tokens);
  if (!stage) return null;

  const sessionId = input?.session_id;
  // Посреди хода без id сессии дедупликации нет, а вызовов сотни: молчим, иначе
  // текст повторился бы после каждого из них.
  if (phase === 'step' && !sessionId) return null;

  const seen = sessionId ? record(sessionId) : null;
  if (seen?.stage && RANK[seen.stage] >= RANK[stage]
    && !mayRepeat(phase, stage, used.tokens, seen)) {
    return null;
  }
  if (sessionId) update(sessionId, { stage, tokens: used.tokens });

  return {
    stage,
    pct: used.pct,
    tokens: used.tokens,
    text: noticeText(stage, used.tokens, { sessionId, phase, worked: seen?.worked === true }),
  };
}
