// Общая логика гард-хуков tokensave — единая точка истины для всех harness'ов
// (Claude Code, OpenCode). Модуль чистый: не читает stdin, не пишет stdout,
// не знает про формат хуков. Возвращает причину запрета (string) или null.
//
// Единственный критерий: файл есть в индексе tokensave (таблица files в
// .tokensave/tokensave.db). Есть — значит tokensave его отдаст, и читать/править
// его надо через tokensave. Нет — гарду там делать нечего: пусть работают
// обычные инструменты агента. Списка расширений нет: что считать кодом, решает
// сам индекс, а не догадка хука.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { currentBranch, statePath, readJSON, writeJSON } from './state-core.mjs';
import { logDecision, hookContext } from './hooklog-core.mjs';
import { maybeSpawnDoctor } from './doctor-core.mjs';
import { segments, tokenize, commandName } from './shell-core.mjs';

const HOME = process.env.HOME || os.homedir();
const TS_DIR = '.tokensave';
const DEFAULT_DB = 'tokensave.db';
const DB_REL = path.join(TS_DIR, DEFAULT_DB);

// Сколько ждать идущий tokensave sync, прежде чем замолчать (см. syncBusy).
// 800 мс, а не 6000: на большом проекте sync идёт десятки секунд (на web_groza
// замерено 21.4 с), и шесть секунд ожидания в каждом вызове инструмента
// превращались в видимое «залипание» ответа — при том что дождаться конца
// такого sync всё равно нельзя. Короткая пауза ловит быстрый sync, а на
// длинном гард честно отступает.
const SYNC_WAIT_MS = Number(process.env.TS_GUARD_SYNC_WAIT_MS || 800);
const SYNC_POLL_MS = 200;

// Конфиг/тулинг самих агентов (.claude/…, .opencode/…, ~/.config/opencode/…,
// ~/.ai-hooks/…) — гарды его не трогают, иначе нельзя читать/править
// собственные хуки (источник «цикла»).
const HARNESS_CONFIG_RE =
  /(^|[\\/])(\.claude|\.opencode|\.ai-hooks)([\\/]|$)|[\\/]\.config[\\/]opencode([\\/]|$)/;

export function isHarnessConfigPath(p) {
  return HARNESS_CONFIG_RE.test(String(p || ''));
}

// Корень tokensave-проекта: ближайший каталог вверх по дереву с БД.
// $HOME не считается: ~/.tokensave существует всегда (global.db + config.toml),
// иначе весь домашний каталог был бы «проектом».
function findRoot(startDir) {
  let dir = startDir;
  while (dir) {
    if (fs.existsSync(path.join(dir, DB_REL))) {
      return path.resolve(dir) === path.resolve(HOME) ? null : dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}

export function projectRoot(cwd, filePath) {
  const base = cwd ? path.resolve(cwd) : process.cwd();
  if (filePath) {
    // Каталог — начинаем поиск с него самого, файл — с его каталога. Без
    // различения `grep ... .` уводил поиск корня на уровень выше проекта: для
    // `.` брался dirname, то есть родитель. Пока родительский каталог не был
    // сам проектом, ошибка не проявлялась.
    const abs = path.resolve(base, String(filePath));
    let start;
    try {
      start = fs.statSync(abs).isDirectory() ? abs : path.dirname(abs);
    } catch {
      start = path.dirname(abs); // не существует — считаем файлом
    }
    const fromFile = findRoot(start);
    if (fromFile) return fromFile;
  }
  return findRoot(base);
}

// Ветка (currentBranch из state-core). tokensave держит отдельную БД на ветку
// (branch-meta.json), и MCP отвечает из БД текущей ветки. Гард обязан смотреть
// в тот же файл: иначе на ветке dev он судит по графу main — файл, добавленный
// в dev, «не в индексе» (запрета нет там, где он нужен), а удалённый в dev —
// «в индексе» (запрет там, где tokensave отдаст чужое содержимое).

// Путь к БД активной ветки или null, если гарду тут делать нечего.
// null означает «tokensave сейчас не является достоверным источником»:
// ветка не отслеживается (branch add ещё не прошёл или упал) либо detached HEAD.
// Заставлять tokensave в такой ситуации — загонять правку в граф чужой ветки.
const dbPathCache = new Map();
function dbPath(root) {
  if (dbPathCache.has(root)) return dbPathCache.get(root);
  let file = DEFAULT_DB;
  try {
    const metaPath = path.join(root, TS_DIR, 'branch-meta.json');
    if (fs.existsSync(metaPath)) {
      const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
      const branches = meta.branches || {};
      const isRepo = fs.existsSync(path.join(root, '.git'));
      const branch = currentBranch(root);
      const entry = isRepo
        ? (branch ? branches[branch] : null)
        : branches[meta.default_branch];
      file = entry?.db_file || null;
    }
  } catch {
    file = DEFAULT_DB; // сломанный meta — работаем по одной БД, как раньше
  }
  const resolved = file ? path.join(root, TS_DIR, file) : null;
  dbPathCache.set(root, resolved);
  return resolved;
}

// Идёт ли прямо сейчас tokensave sync/init/branch add по этому проекту.
// /proc, а не flock: проверка без порождения процесса на каждый вызов хука.
function syncRunning(root) {
  try {
    const target = path.resolve(root);
    for (const pid of fs.readdirSync('/proc')) {
      if (!/^\d+$/.test(pid)) continue;
      let raw;
      try { raw = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8'); } catch { continue; }
      // Имя ищем в любом аргументе, а не только в argv[0]: фоновые задачи
      // запускают бинарь через bash/setsid/flock, и argv[0] там — обёртка.
      const argv = raw.split('\0').filter(Boolean);
      if (!argv.some((a) => path.basename(a) === 'tokensave')) continue;
      if (!argv.some((a) => a === 'sync' || a === 'init' || a === 'add')) continue;
      if (argv.slice(1).some((a) => !a.startsWith('-') && path.resolve(a) === target)) return true;
    }
  } catch { /* нет /proc — считаем, что sync не идёт */ }
  return false;
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// Пока идёт sync, граф неполон, а write-tools отвечают ошибкой. Запрет в этот
// момент даёт цикл «запрет → tokensave падает → тот же запрет». Обычный sync
// укладывается в доли секунды — ждём его и дальше судим по свежему графу.
// Не уложился за SYNC_WAIT_MS (первичный init, большой репозиторий) — гард
// молчит: ждать дольше дороже, чем разово пропустить обычный инструмент.
// Результат мемоизируется: процесс хука живёт один вызов, ждать надо один раз.
const syncChecked = new Map();
function syncBusy(root) {
  if (syncChecked.has(root)) return syncChecked.get(root);
  let busy = syncRunning(root);
  if (busy) {
    const deadline = Date.now() + SYNC_WAIT_MS;
    while (busy && Date.now() < deadline) {
      sleepSync(SYNC_POLL_MS);
      busy = syncRunning(root);
    }
  }
  syncChecked.set(root, busy);
  return busy;
}

// ---------------------------------------------------------------------------
// Совпадение с MCP-сервером. Гард запрещает Read/Grep/Edit только потому, что то
// же самое отдаст tokensave. Если сервер обслуживает другой проект или другую
// ветку, замены нет: запрет упирается в пустой ответ, агент повторяет вызов и
// получает тот же отказ.
//
// Сервер регистрирует себя в ~/.tokensave/servers/<pid>.json (project_path,
// db_path). Сверяем с тем, по чему судит гард. Ни один живой сервер не совпал —
// гард молчит и пишет причину в guard.log.

// Читается на каждый вызов, а не в константу при импорте: тесты подменяют
// реестр переменной окружения уже после того, как модуль загружен.
function serversDir() {
  return process.env.TS_SERVERS_DIR || path.join(HOME, TS_DIR, 'servers');
}

// Живой `tokensave serve` для этого проекта — по /proc, как syncRunning.
// Нужно потому, что tokensave 7.11.x создаёт ~/.tokensave/servers/, но записи
// в него не пишет: реестр всегда пуст, и «пусто» перестало означать «сервера
// нет». Проверка процесса напрямую отвечает на вопрос, для которого реестр
// заводился, — обслуживает ли кто-то этот корень.
// TS_SERVE_ROOTS (список путей через разделитель PATH) подменяет результат в
// тестах — как TS_SERVERS_DIR подменяет реестр; пустая строка = «серверов нет».
function serveRunning(root) {
  const override = process.env.TS_SERVE_ROOTS;
  if (override !== undefined) {
    return override.split(path.delimiter).filter(Boolean)
      .some((p) => path.resolve(p) === path.resolve(root));
  }
  try {
    const target = path.resolve(root);
    for (const pid of fs.readdirSync('/proc')) {
      if (!/^\d+$/.test(pid)) continue;
      let raw;
      try { raw = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8'); } catch { continue; }
      const argv = raw.split('\0').filter(Boolean);
      if (!argv.some((a) => path.basename(a) === 'tokensave')) continue;
      if (!argv.includes('serve')) continue;
      const i = argv.findIndex((a) => a === '-p' || a === '--path');
      if (i !== -1) {
        if (argv[i + 1] && path.resolve(argv[i + 1]) === target) return true;
        continue;
      }
      // serve без -p берёт cwd процесса
      try {
        if (path.resolve(fs.readlinkSync(`/proc/${pid}/cwd`)) === target) return true;
      } catch { /* нет доступа к cwd — пропускаем */ }
    }
  } catch { /* нет /proc — на этой ОС проверить нечем */ }
  return false;
}

// { ok } либо { ok:false, servers:[…] } — список нужен логу, чтобы рассинхрон
// читался по записи целиком, без ручного обхода реестра.
const serverCache = new Map();
function serverState(root, wantDb) {
  const cacheKey = `${root}\0${wantDb}`;
  if (serverCache.has(cacheKey)) return serverCache.get(cacheKey);

  let result;
  try {
    const seen = [];
    let ok = false;
    const dir = serversDir();
    for (const name of fs.readdirSync(dir)) {
      if (!name.endsWith('.json')) continue;
      const s = readJSON(path.join(dir, name), null);
      // Мёртвый pid — запись осталась от прошлой сессии, её просто нет.
      if (!s?.pid || !fs.existsSync(`/proc/${s.pid}`)) continue;
      seen.push({ pid: s.pid, project: s.project_path || null, db: s.db_path || null });
      if (path.resolve(s.project_path || '') !== path.resolve(root)) continue;
      if (s.db_path && path.resolve(s.db_path) !== path.resolve(wantDb)) continue;
      ok = true;
    }
    // Реестр не дал ни одной живой записи — либо серверов нет, либо это версия
    // tokensave, которая себя не регистрирует. Сверяемся с /proc: нашёлся живой
    // serve на этот корень — замена есть, гард работает как обычно. Не нашёлся —
    // прежнее поведение (fail-open), но без записи выдуманного рассинхрона.
    if (!ok && seen.length === 0 && serveRunning(root)) ok = true;
    result = ok ? { ok } : { ok, servers: seen };
  } catch {
    // Нет реестра (старая версия tokensave) — сверять нечем, ведём себя как
    // раньше: судим по БД. Отсутствие данных не повод снимать запреты везде.
    result = { ok: true };
  }

  serverCache.set(cacheKey, result);
  return result;
}

// ---------------------------------------------------------------------------
// Диагностический лог. Пишется только там, где гард отступает от своего
// правила, — этих событий в норме ноль, поэтому файл не шумит. Всё, что нужно
// для разбора («по какой БД судил гард, что обслуживал сервер»), в одной строке.

// Путь и дедуп читаются на каждый вызов: тестам нужен свой файл, иначе прогон
// сьюта дописывает выдуманные рассинхроны в журнал, по которому потом
// разбирают настоящие.
const guardLog = () =>
  process.env.AI_HOOKS_GUARD_LOG || path.join(HOME, '.ai-hooks', 'logs', 'guard.log');
const LOG_DEDUP_MS = 60 * 1000;

export function logGuard(event, data = {}) {
  try {
    const now = Date.now();
    // Рассинхрон срабатывает на каждом кандидате пути внутри одного вызова —
    // без дедупа одна команда даёт десяток одинаковых строк.
    const key = `${event}|${data.root || ''}|${data.guard_db || ''}|${data.tool || ''}`;
    const dedupFile = statePath('guard-log.json');
    const seen = readJSON(dedupFile, {});
    for (const [k, t] of Object.entries(seen)) {
      if (typeof t !== 'number' || now - t > LOG_DEDUP_MS) delete seen[k];
    }
    if (seen[key]) return false;
    seen[key] = now;
    writeJSON(dedupFile, seen);

    const file = guardLog();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file,
      JSON.stringify({ ts: new Date(now).toISOString(), event, ...data }) + '\n');
    // То же событие — в журнал решений сессии (hooks.jsonl): guard.log остаётся
    // «в норме пустым» сигналом, а hooks.jsonl даёт последовательность внутри
    // сессии. Строку с предохранителем hook-io пишет сам — там есть target.
    if (event === 'server-mismatch') {
      logDecision(event, { root: data.root, branch: data.branch, servers: (data.servers || []).length });
    }
    return true;
  } catch {
    return false; // лог не обязан работать, чтобы работал гард
  }
}

// Любая проблема с БД (нет файла, залочена, сменилась схема) → null, и гард
// молчит. Fail-open осознанно: запретить, не дав рабочей альтернативы, — тупик,
// из которого агент начинает искать обходные пути. Пропущенный запрет дешевле.
function query(root, fn) {
  const file = dbPath(root);
  if (!file || syncBusy(root)) return null;

  const srv = serverState(root, file);
  if (!srv.ok) {
    const detail = {
      root,
      branch: currentBranch(root),
      guard_db: path.relative(root, file),
      servers: srv.servers,
    };
    // Молчание гарда — тоже симптом: проект инициализирован, а роутеры
    // отключились. Доктор запускается на новое событие (не на дедуп-повтор);
    // частоту дальше держит его собственный дебаунс по проекту.
    if (logGuard('server-mismatch', detail)) {
      maybeSpawnDoctor({ root, symptom: 'server-mismatch', detail, sid: hookContext().sid });
    }
    return null;
  }

  let db;
  try {
    db = new DatabaseSync(file, { readOnly: true });
    return fn(db);
  } catch {
    return null;
  } finally {
    try { db?.close(); } catch { /* уже закрыта */ }
  }
}

// Пути в files — относительные от корня проекта, всегда через '/'.
function relKey(root, cwd, filePath) {
  const abs = path.resolve(cwd || process.cwd(), String(filePath));
  const rel = path.relative(root, abs);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return rel.split(path.sep).join('/');
}

// Файл есть в индексе tokensave? Нового файла там нет — поэтому создание
// через Write разрешено автоматически, без отдельной проверки existsSync.
export function isIndexed(cwd, filePath) {
  if (!filePath) return false;
  if (isHarnessConfigPath(filePath)) return false;
  const root = projectRoot(cwd, filePath);
  if (!root) return false;
  const key = relKey(root, cwd, filePath);
  if (!key) return false;
  return query(root, (db) => !!db.prepare('SELECT 1 FROM files WHERE path = ?').get(key)) ?? false;
}

// Есть ли под данным путём (файлом или каталогом) хоть один проиндексированный
// файл? Ключ — относительный от корня, через '/'. Нужен для grep с конкретной
// целью: поиск по node_modules/dist/любой вендорной папке уходит мимо индекса и
// блокировать его нельзя, даже если расширение цели (.css/.js) совпадает с тем,
// что индексируется в src.
function hasIndexedUnder(root, relPath) {
  return query(root, (db) => {
    if (db.prepare('SELECT 1 FROM files WHERE path = ?').get(relPath)) return true;
    const prefix = (relPath.endsWith('/') ? relPath : relPath + '/').replace(/([%_\\])/g, '\\$1');
    return !!db.prepare("SELECT 1 FROM files WHERE path LIKE ? ESCAPE '\\' LIMIT 1").get(prefix + '%');
  }) ?? false;
}

// Расширения, которые tokensave реально проиндексировал в этом проекте.
// Нужны для grep: у поиска нет одного конкретного файла, есть только маска.
// Экспортируется для тестов: состав индекса зависит от ветки, и ожидания
// нельзя зашивать константой.
export function indexedExtensions(root) {
  return indexedExts(root);
}

function indexedExts(root) {
  return query(root, (db) => {
    const set = new Set();
    for (const r of db.prepare('SELECT path FROM files').all()) {
      const ext = path.extname(r.path).toLowerCase();
      if (ext) set.add(ext);
    }
    return set;
  });
}

// Имена инструментов различаются между harness'ами — подставляем их в текст
// запрета, чтобы сообщение указывало на реально доступный агенту инструмент.
// prefix — префикс MCP-инструментов tokensave: Claude показывает их как
// tokensave_context, OpenCode добавляет ещё и имя MCP-сервера → tokensave_tokensave_context.
export const CLAUDE_LABELS = {
  read: 'Read', grep: 'Grep', edit: 'Edit/Write',
  prefix: 'tokensave_',
  editNote: 'Подтверждения не требуют. Полное имя — mcp__tokensave__tokensave_<tool>; ' +
    "нет в списке → ToolSearch('select:mcp__tokensave__tokensave_str_replace').",
};

export const OPENCODE_LABELS = {
  read: 'read', grep: 'grep', edit: 'edit/write',
  prefix: 'tokensave_tokensave_',
  editNote: 'Подтверждения не требуют — применяй сразу.',
};

const FALLBACK =
  "Нет tokensave_* в списке → ToolSearch('select:mcp__tokensave__tokensave_read,mcp__tokensave__tokensave_str_replace'). " +
  'Сомнение в индексе → tokensave_status. ' +
  'Read/Edit/Write — только после ошибки или пустого ответа tokensave_*, с цитатой ошибки. Shell — никогда.';

// ---------------------------------------------------------------------------
// Предохранитель. Запрет полезен, пока у агента есть рабочая альтернатива.
// Когда её нет (tokensave отвечает ошибкой, зовётся с неверными аргументами,
// граф не той ветки), агент повторяет тот же вызов и получает тот же отказ —
// в логах это семь одинаковых Edit подряд. Второй запрет на ту же цель ничего
// не сообщает сверх первого, поэтому его не выдаём: пропускаем вызов.

const BREAKER_FILE = statePath('guard-breaker.json');
const BREAKER_WINDOW_MS = 3 * 60 * 1000;

export function denialKey(toolName, toolInput = {}) {
  const ti = toolInput || {};
  const target =
    ti.file_path || ti.path || ti.command || ti.code || ti.pattern || ti.glob || '';
  return `${toolName}:${String(target).replace(/\s+/g, ' ').slice(0, 200)}`;
}

// Что делать с вызовом:
//   false      — запрещаем как обычно (запрета на эту цель ещё не было);
//   'announce' — пропускаем и объясняем почему (первый пропуск в окне);
//   'silent'   — пропускаем молча (объяснение уже прозвучало).
//
// Различие между 'announce' и 'silent' и есть лекарство от спама: пока латч
// открыт, пропускается КАЖДОЕ чтение, и текст «запрет снят…» печатался к
// каждому из них — до тридцати одинаковых простыней за три минуты. Сказать это
// один раз достаточно: второе такое сообщение не добавляет ничего к первому.
//
// Любая ошибка состояния → false (запрещаем как обычно): потерянная метка
// безопаснее пропущенного запрета.
export function breakerAllows(sessionId, key, family = null) {
  const sid = sessionId || 'default';
  const id = `${sid}|${key}`;
  const famId = family ? `${sid}|fam:${family}` : null;
  // Об одном классе говорим один раз; без family — по конкретной цели.
  const sayId = `${sid}|say:${family || key}`;
  const now = Date.now();
  const state = readJSON(BREAKER_FILE, {}); // первого запрета ещё не было → {}

  for (const [k, v] of Object.entries(state)) {
    if (!v || typeof v.t !== 'number' || now - v.t > BREAKER_WINDOW_MS) delete state[k];
  }

  const entry = state[id];
  const famOpen = famId ? Boolean(state[famId]) : false;
  // Пропускаем, если эту цель уже запрещали в окне, либо повтор случился на
  // соседней цели того же класса — tokensave не работает на всём графе.
  const open = Boolean(entry) || famOpen;
  state[id] = { t: entry?.t ?? now };
  // Латч класса открывается на ПЕРВОМ реальном повторе (entry уже был) и живёт
  // фиксированное окно от него. Раньше таймстамп двигался вперёд на каждой
  // соседней цели, пока латч открыт, — в активной сессии окно не закрывалось
  // никогда, и подсказка «tokensave пропущен» липла до конца работы. Соседние
  // цели (entry не было) латч только читают, но не продлевают.
  if (famId && entry) state[famId] = { t: state[famId]?.t ?? now };

  const announced = open && Boolean(state[sayId]);
  if (open && !announced) state[sayId] = { t: now };

  writeJSON(BREAKER_FILE, state); // не записали — в худшем случае запретим ещё раз

  if (!open) return false;
  return announced ? 'silent' : 'announce';
}

// Чтение файла: есть в индексе → только tokensave.
export function guardRead(filePath, cwd, labels) {
  if (!isIndexed(cwd, filePath)) return null;
  const p = labels.prefix;
  return (
    `Файл в индексе tokensave. Вместо ${labels.read}: ${p}read (файл), ` +
    `${p}body/${p}signature (символ), ${p}context (обзор). ${FALLBACK}`
  );
}

// Поиск: цель явно ограничена тем, чего нет в индексе (json/yaml/конфиги) → можно.
// Иначе это поиск по проиндексированному коду → tokensave.
export function guardGrep({ path: searchPath, glob, type }, cwd, labels) {
  if (isHarnessConfigPath(searchPath)) return null;
  const root = projectRoot(cwd, searchPath);
  if (!root) return null;

  // Поиск направлен в конкретный путь → решаем по индексу, а не по расширению:
  // вне корня или без единого проиндексированного файла под ним (node_modules,
  // dist, вендор) — блокировать нечего. Пустой rel = сам корень, под ним индекс
  // есть → проходим дальше к маске.
  if (searchPath) {
    const rel = path.relative(root, path.resolve(cwd || process.cwd(), String(searchPath)));
    if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
    if (rel !== '' && !hasIndexedUnder(root, rel.split(path.sep).join('/'))) return null;
  }

  const exts = indexedExts(root);
  if (!exts || exts.size === 0) return null;

  if (type) {
    if (!exts.has('.' + String(type).toLowerCase())) return null;
  } else if (glob && /\.\w+/.test(String(glob))) {
    const globExts = [...String(glob).matchAll(/\.\w+/g)].map((m) => m[0].toLowerCase());
    if (globExts.every((e) => !exts.has(e))) return null;
  }

  const p = labels.prefix;
  return (
    `Поиск по индексу tokensave. Вместо ${labels.grep}: ${p}search (символ; literal:true — строка), ` +
    `${p}callers/${p}field_sites (использования), ${p}context. ` +
    `Вне индекса — ограничь glob/type (напр. type:"json"). ${FALLBACK}`
  );
}

// ---------------------------------------------------------------------------
// Shell. Read/Grep/Edit закрыты по имени инструмента, но те же действия
// выражаются командой: `cat file`, `sed -i`, `node -e "fs.writeFileSync(…)"`,
// `> file`. Без этого гарда shell — не обход по недосмотру, а единственная
// открытая дверь, и агент в неё уходит, как только упрётся в запрет.
//
// Критерий тот же: в команде упомянут файл из индекса. Разбор нарочно грубый —
// не парсер shell, а распознавание форм. Всё, что не распозналось, проходит:
// лучше пропустить обход, чем заблокировать `git`, `tsc`, `eslint` над теми же
// путями (они читают файл легитимно, замены в tokensave для них нет).

// Команды, которые читают содержимое файла.
const READ_CMDS = new Set([
  'cat', 'head', 'tail', 'less', 'more', 'bat', 'nl', 'tac', 'rev',
  'od', 'xxd', 'strings',
]);

// Команды, которые пишут в файл на месте. sed/perl/awk — только с -i.
const WRITE_CMDS = new Set(['tee', 'dd', 'truncate', 'install']);
const INPLACE_CMDS = new Set(['sed', 'perl', 'awk', 'gawk']);

// Интерпретаторы: путь прячется внутри строки кода, поэтому у них смотрим
// весь сегмент целиком, а не отдельные аргументы.
const EVAL_CMDS = new Set(['node', 'python', 'python3', 'ruby', 'perl', 'php', 'deno', 'bun', 'jq']);
// Признак строки кода в аргументах или heredoc. Без него интерпретатор
// исполняет скрипт (`node test/test-guards.mjs`) — это запуск, как `tsc` или
// `eslint`, а не чтение; запрет ловил команды из README и толкал в обход
// через переменную (`node "$t"`). jq всегда читает свой аргумент.
const INLINE_CODE_RE = /^(-e|--eval|-p|--print|-c|-E|-r|eval)$|^--(eval|print)=/;
function runsInlineCode(cmd, toks, seg) {
  if (cmd === 'jq') return true;
  return toks.slice(1).some((t) => INLINE_CODE_RE.test(t)) || /<<-?\s*['"\\]?\w+/.test(seg);
}

const GREP_CMDS = new Set(['grep', 'egrep', 'fgrep', 'rg', 'ag', 'ack']);

// Сегменты, токены и имя команды — из shell-core.mjs, общего с остальными
// гардами. Сегмент из пайпа читает stdin, а не файлы (`ps aux | grep foo`).
// keepHeredoc: тело `node <<EOF … EOF` — часть сегмента интерпретатора, иначе
// путь внутри него распадался бы на безобидные строки.

// Кандидаты в пути: всё, что похоже на файл с расширением. Ловит и голые
// аргументы, и пути внутри строк кода — поэтому применяется к сырому сегменту.
function pathCandidates(text) {
  return new Set(String(text).match(/[\w@.\-/\\]*\.\w+/g) || []);
}

function anyIndexed(text, cwd) {
  for (const c of pathCandidates(text)) if (isIndexed(cwd, c)) return c;
  return null;
}

// rg/ag/ack без аргументов-путей обходят текущий каталог; обычный grep в такой
// ситуации читает stdin. Разница определяет, есть ли что проверять.
const RECURSIVE_BY_DEFAULT = new Set(['rg', 'ag', 'ack']);

// grep внутри shell — та же семантика, что и у инструмента Grep: цель, явно
// ограниченная непроиндексированным расширением, разрешена.
//
// Важно: команда, читающая stdin, файлов не касается. Из пайпа (`ps aux | grep`,
// `git log | grep fix`) или без путей-аргументов — блокировать нечего, иначе
// запрет ловит обычную работу с выводом команд и толкает в обход.
function bashGrep(toks, cwd, labels, cmd, piped) {
  if (piped) return null;

  const globs = [];
  const rest = [];
  let recursive = RECURSIVE_BY_DEFAULT.has(cmd);
  for (let i = 1; i < toks.length; i++) {
    const t = toks[i];
    if (t.startsWith('--include=')) globs.push(t.slice('--include='.length));
    else if (t === '-g' || t === '--glob' || t === '--include') globs.push(toks[++i] || '');
    else if (t === '-e' || t === '-f') i++; // паттерн, не путь
    else if (t === '--recursive' || (/^-[a-zA-Z]{1,4}$/.test(t) && /[rR]/.test(t))) recursive = true;
    else if (t.startsWith('-')) continue;
    else rest.push(t);
  }
  rest.shift(); // первый свободный аргумент — паттерн

  // Нет ни путей, ни рекурсии → читает stdin.
  if (rest.length === 0 && !recursive) return null;
  return guardGrep({ path: rest[0], glob: globs[0] }, cwd, labels);
}

// Возвращает причину запрета или null. Любая неожиданность → null (fail-open).
export function guardBash(command, cwd, labels) {
  if (!command) return null;
  try {
    for (const { text: seg, piped } of segments(command, { keepHeredoc: true })) {
      const toks = tokenize(seg);
      const cmd = commandName(toks);

      if (GREP_CMDS.has(cmd)) {
        const reason = bashGrep(toks, cwd, labels, cmd, piped);
        if (reason) return reason;
        continue;
      }

      // Перенаправление в файл — независимо от команды слева.
      const redirect = seg.match(/>>?\s*([\w@.\-/\\]+)/);
      if (redirect && isIndexed(cwd, redirect[1])) return bashEditReason(redirect[1], labels);

      if (READ_CMDS.has(cmd)) {
        const hit = anyIndexed(seg, cwd);
        if (hit) return bashReadReason(hit, labels);
      }

      if (WRITE_CMDS.has(cmd) || (INPLACE_CMDS.has(cmd) && toks.some((t) => /^-i/.test(t) || t === '--in-place'))) {
        const hit = anyIndexed(seg, cwd);
        if (hit) return bashEditReason(hit, labels);
      }

      if (EVAL_CMDS.has(cmd) && runsInlineCode(cmd, toks, seg)) {
        const hit = anyIndexed(seg, cwd);
        if (hit) return bashEvalReason(hit, labels);
      }
    }
  } catch {
    return null;
  }
  return null;
}

// mcp__ide__executeCode — исполнение кода в Jupyter-ядре. Канал мимо Bash,
// но результат тот же, поэтому и правило то же.
export function guardExec(code, cwd, labels) {
  if (!code) return null;
  try {
    const hit = anyIndexed(code, cwd);
    return hit ? bashEvalReason(hit, labels) : null;
  } catch {
    return null;
  }
}

function bashReadReason(file, labels) {
  const p = labels.prefix;
  return (
    `\`${file}\` в индексе tokensave. Вместо shell: ${p}read (файл), ` +
    `${p}body/${p}signature (символ), ${p}context (обзор). ${FALLBACK}`
  );
}

function bashEditReason(file, labels) {
  const p = labels.prefix;
  return (
    `\`${file}\` в индексе tokensave. Вместо shell: ${p}str_replace / ${p}multi_str_replace, ` +
    `${p}replace_symbol, ${p}insert_at. ${labels.editNote} ${FALLBACK}`
  );
}

function bashEvalReason(file, labels) {
  const p = labels.prefix;
  return (
    `\`${file}\` в индексе tokensave. Вместо интерпретатора: читай ${p}read/${p}body, ` +
    `правь ${p}str_replace/${p}replace_symbol. ${FALLBACK}`
  );
}

// Правка файла: есть в индексе → только tokensave write-tools.
export function guardEdit(filePath, cwd, labels) {
  if (!isIndexed(cwd, filePath)) return null;
  const p = labels.prefix;
  return (
    `Файл в индексе tokensave. Вместо ${labels.edit}: ${p}str_replace / ${p}multi_str_replace (точечно), ` +
    `${p}replace_symbol (символ целиком), ${p}insert_at / ${p}insert_at_symbol (вставка). ` +
    `${labels.editNote} ${FALLBACK}`
  );
}
