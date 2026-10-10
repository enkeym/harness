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
// `/clear` передача не зовёт. На пороге агент пишет снимок в файл plan mode и
// выходит через ExitPlanMode — очистку пользователь выбирает в его диалоге.
//
// Замер живёт в двух фазах. 'prompt' — на ходу пользователя, где ничего ещё не
// начато. 'step' — между вызовами инструментов внутри одного хода: автономный ход
// на сотню вызовов проходит все три порога, ни разу не вернувшись к пользователю, и
// без этой фазы пороги для него не существуют. Текст у фаз один: посреди хода
// ответ тоже не бросают на половине — сначала довести шаг, потом передача.
//
// Модуль чистый — без stdin и вывода: его импортируют оба хука и statusline.

import fs from 'node:fs';
import path from 'node:path';
import { statePath, readJSON, writeJSON, repoRoot } from './state-core.mjs';

// Знаменатель процента в статусной строке. 1M — окно моделей с длинным
// контекстом; переопределяется через env для окна поменьше. На пороги не влияет.
export const WINDOW = Number(process.env.AI_HOOKS_CONTEXT_WINDOW) || 1_000_000;

const num = (env, fallback) => Number(process.env[env]) || fallback;

// SOFT — шаг пора закрывать: дальше каждый новый ход оплачивает всё накопленное.
// HAND — собрать передачу, как только шаг доведён.
// HARD — работать здесь уже дорого; напоминание повторяется каждый ход.
export const SOFT = num('AI_HOOKS_CTX_SOFT', 90_000);
export const HAND = num('AI_HOOKS_CTX_HAND', 150_000);
export const HARD = num('AI_HOOKS_CTX_HARD', 220_000);

// На сколько должен вырасти контекст, чтобы верхний порог прозвучал посреди хода
// ещё раз. На ходу пользователя мерой повтора служит сам ход; внутри хода ходов
// нет, а вызовов инструментов сотни — привязка к их числу превратила бы
// напоминание в шум на каждом вызове.
export const STEP_REPEAT = num('AI_HOOKS_CTX_STEP_REPEAT', 20_000);

// Предел длины одного промпта в символах. Пороги выше ловят рост контекста по
// ходу работы, но не старт: три сессии из 35 открылись сразу на 200k, потому что
// в промпт вставили дамп БД под блоком передачи — 250k символов, 155k токенов,
// больше, чем стоит база всех остальных сессий вместе. Нормальная передача —
// до 6k символов, так что предел в разы выше неё и ниже любого дампа.
export const PASTE_LIMIT = num('AI_HOOKS_PASTE_LIMIT', 40_000);

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

// Инструменты, после которых в сессии есть что передавать: правка файла внутри
// git-корня сессии или коммит. Чтение и поиск сюда не входят намеренно — ими
// порог как раз и берётся. Запись вне репозитория (память и план в ~/.claude/,
// скрипт в /tmp) не работа: коммитить там нечего, а «закрой шаг коммитом» в
// аудите без правок агент принимал за инъекцию.
const EDIT_TOOL = /^(Edit|Write|MultiEdit|NotebookEdit)$/;
const EDIT_MCP = /(str_replace|insert_at|replace_symbol)/;

function inRepo(file, cwd) {
  const root = repoRoot(cwd);
  if (!root || !file) return false;
  const rel = path.relative(root, path.resolve(root, String(file)));
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
}

export function isWork(toolName, toolInput, cwd) {
  if (!toolName) return false;
  if (EDIT_TOOL.test(toolName)) return inRepo(toolInput?.file_path || toolInput?.notebook_path, cwd);
  // replace_symbol и insert_at_symbol пути не несут: символ — из индекса проекта сессии.
  if (EDIT_MCP.test(toolName)) return toolInput?.path ? inRepo(toolInput.path, cwd) : Boolean(repoRoot(cwd));
  if (toolName === 'Bash') return /\bgit\s+commit\b/.test(String(toolInput?.command || ''));
  return false;
}

// Была ли в сессии работа — для Stop-хука, который судит конец хода по порогу.
export function sessionWorked(sessionId) {
  return Boolean(sessionId && record(sessionId)?.worked);
}

// Отметка «в сессии появилась работа». Пишется один раз за сессию: дальше запись
// уже стоит, и файл на каждом вызове инструмента не трогаем.
export function noteWork(input) {
  const sessionId = input?.session_id;
  if (!sessionId || !isWork(input?.tool_name, input?.tool_input, input?.cwd)) return false;
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

// HAND или HARD, объявленный сессии без правок, передачу не просил: передавать
// было нечего. Первая правка это меняет, и тот же порог звучит ещё раз — уже с
// передачей. Без этого следующим сигналом был бы только HARD: по транскриптам
// сессии, начавшие правки после HAND на 177k и 203k, доехали до 224k и 233k.
// SOFT не повторяем: на HAND сессия с правками и так получит передачу.
function workSinceIdle(seen, worked) {
  return worked && seen.idle === true && RANK[seen.stage] >= RANK.hand;
}

const k = (tokens) => `${Math.round(tokens / 1000)}k`;

// null — промпт проходит. Иначе текст отказа для пользователя: промпт длиннее
// PASTE_LIMIT не попадает в контекст вовсе. Отказ, а не предупреждение: после
// отправки вставка уже оплачена и остаётся в окне до конца сессии, вернуть её
// нельзя. Данные идут через файл — сессия обрабатывает его скриптом и читает
// только итог.
export function oversizedPrompt(prompt) {
  const text = typeof prompt === 'string' ? prompt : '';
  if (text.length <= PASTE_LIMIT) return null;
  return `Промпт ${k(text.length)} символов при пределе ${k(PASTE_LIMIT)} — в контекст не отправлен: `
    + 'одна такая вставка стоит больше, чем вся база сессии, и остаётся в окне до её конца. '
    + 'Сохрани данные в файл и дай путь — сессия обработает их скриптом, а прочитает только '
    + 'итог. Блок передачи — без дампов, логов и таблиц данных (скилл `handoff`). '
    + 'Предел: AI_HOOKS_PASTE_LIMIT.';
}

// Шесть текстов: порог × была ли в сессии работа. Фаза на текст не влияет:
// «доведи текущий шаг» верно и на ходу пользователя, и посреди хода.
//
// Тексты — только команды, без обоснований: длинные объяснения Sonnet принимал
// за инъекцию в выводе инструмента. Источник — одно слово в начале; ничего не
// велит скрывать от пользователя. Как собирать передачу (меню вопросов, коммит
// шага, план-файл, ExitPlanMode) знает скилл `handoff` — хук его только называет.
//
// Сессия с правками на SOFT закрывает шаг и спрашивает про перенос: без вопроса
// «новый не начинай» кончался прозой «лучше в новой сессии», которую никто не замечал.
// Сессия без правок на SOFT передачу не собирает: блок свёлся бы к списку
// прочитанного, и новая сессия упёрлась бы в тот же порог. От HAND такая сессия
// чаще обсуждение: её результат — вывод, и перенос решает пользователь.
//
// Перенос — только когда работа продолжается (DONE): закрытая задача или одна
// мелкая правка доделываются здесь и кончаются итогом. Безусловная передача
// «и когда шагов не осталось» предлагала перенос сессии, в которой переносить нечего.
// Критерий — факты, не ощущение: шаг плана, проверка, ждущее решение.
const DONE = 'Задача закрыта или осталась мелкая правка — доделай и закончи ход итогом, без переноса.';
const ASK_MOVE = 'вопрос AskUserQuestion: «Перенести в новую сессию» первым, «Продолжить здесь» '
  + '(скилл `handoff`).';
const REST = 'Остались шаги плана или проверка —';
const TEXTS = {
  worked: {
    soft: `Доведи текущий шаг до коммита. ${DONE} ${REST} после коммита ${ASK_MOVE}`,
    hand: `Доведи текущий шаг, следующий не начинай. ${DONE} ${REST} закончи ход `
      + 'передачей по скиллу `handoff`.',
    hard: `Новую работу не начинай. ${DONE} Остальное доведи или назови `
      + 'незавершённым и закончи ход передачей по скиллу `handoff`.',
  },
  idle: {
    soft: 'Правок нет. Читай символом или диапазоном, прочитанное повторно не открывай. '
      + 'Работу продолжай, передачу не собирай.',
    hand: 'Правок нет. Дочитай только необходимое и выдай вывод. Вопрос исчерпан — закончи '
      + `ход выводом, без переноса. Обсуждение продолжается — ${ASK_MOVE}`,
    hard: 'Правок нет. Дочитай необходимое и выдай вывод; не хватает — скажи пользователю, '
      + `что задачу надо сузить. Вопрос исчерпан — без переноса; обсуждение идёт — ${ASK_MOVE}`,
  },
};

export function noticeText(stage, tokens, { worked = false } = {}) {
  return `context-meter: ${k(tokens)} токенов. ${TEXTS[worked ? 'worked' : 'idle'][stage]}`;
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
  const worked = seen?.worked === true;
  if (seen?.stage && RANK[seen.stage] >= RANK[stage]
    && !mayRepeat(phase, stage, used.tokens, seen)
    && !workSinceIdle(seen, worked)) {
    return null;
  }
  if (sessionId) update(sessionId, { stage, tokens: used.tokens, idle: !worked });

  return {
    stage,
    pct: used.pct,
    tokens: used.tokens,
    text: noticeText(stage, used.tokens, { worked }),
  };
}
