// Цепочка передач handoff между сессиями Claude Code и подсказка, куда ушла
// работа сессии, открытой через resume.
//
// Передача — ExitPlanMode, в диалоге которого пользователь выбрал очистку
// контекста: Claude Code пишет в старую сессию отказ и открывает новую, чей
// первый промпт — план. Текст отказа тот же, что у отклонённого плана
// (`toolDenialKind: user-rejected`), ссылок между файлами нет. Связывает их
// только первая запись нового транскрипта: planContent с тем же slug в ту же
// секунду, что и отказ в старом.
//
// После перезагрузки /resume открывал звено цепочки, а не последнее: заголовки
// звеньев похожи, каждое начинается с одного и того же плана, а модель звена
// не знает о работе, сделанной после передачи («этого в текущей сессии я не
// делал» — dual-vpn, 14.10.2026). successorOf находит последнее звено.
//
// Передача без очистки: диалог ExitPlanMode через Remote Control (телефон)
// контекст не очищает — инструмент отвечает «User has approved your plan» в той
// же сессии (mebel, 24.10.2026, четыре сессии подряд). Тогда снимок помечается
// (markPending), и следующая сессия того же корня после /clear или запуска
// получает его в контексте (takePending): пользователю хватает «продолжи».
//
// Модуль чистый — без stdin и вывода.

import fs from 'node:fs';
import path from 'node:path';
import { transcriptLines } from './context-core.mjs';
import { statePath, readJSON, writeJSON, repoRootOr, projectKey } from './state-core.mjs';

// Отказ в старой сессии и первая запись новой расходятся на миллисекунды;
// запас — на медленный старт.
const LINK_MS = 10_000;
// Голова транскрипта, в которой лежит первый промпт: перед ним только
// служебные записи и снимок истории файлов.
const HEAD_BYTES = 256 * 1024;
const MAX_HOPS = 50;

const parse = (line) => { try { return JSON.parse(line); } catch { return null; } };
const time = (rec) => Date.parse(rec?.timestamp) || 0;

// Промпт, набранный человеком: не результат инструмента, не служебная вставка
// команды и не отметка о прерывании, которую Claude Code пишет текстом
// пользователя.
function isTypedPrompt(rec) {
  if (rec.isMeta) return false;
  const c = rec.message?.content;
  const text = typeof c === 'string' ? c
    : Array.isArray(c) && c.every((b) => b.type === 'text') ? c.map((b) => b.text).join('') : '';
  const t = text.trim();
  return t !== '' && !t.startsWith('[Request interrupted') && !t.startsWith('<');
}

// Последний отклонённый ExitPlanMode основной нити, после которого человек
// здесь больше не писал: { at, slug }. Промпт после него — работа осознанно
// продолжена в этой сессии, и подсказка о передаче была бы ложной.
function lastExit(lines) {
  const ids = new Set();
  let exit = null;
  for (const line of lines) {
    if (!line.includes('"user"') && !line.includes('ExitPlanMode')) continue;
    const rec = parse(line);
    if (!rec || rec.isSidechain) continue;
    if (rec.type === 'assistant') {
      for (const b of rec.message?.content || []) {
        if (b.type === 'tool_use' && b.name === 'ExitPlanMode') ids.add(b.id);
      }
      continue;
    }
    if (rec.type !== 'user') continue;
    const c = rec.message?.content;
    if (Array.isArray(c) && c.some((b) => b.type === 'tool_result' && b.is_error && ids.has(b.tool_use_id))) {
      exit = { at: time(rec), slug: rec.slug };
    } else if (exit && isTypedPrompt(rec)) {
      exit = null;
    }
  }
  return exit;
}

// Первая запись пользователя без чтения мегабайтного файла целиком.
function firstUser(file) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(HEAD_BYTES);
    const n = fs.readSync(fd, buf, 0, HEAD_BYTES, 0);
    for (const line of buf.toString('utf8', 0, n).split('\n')) {
      if (!line.includes('"type":"user"')) continue;
      const rec = parse(line);
      if (rec?.type === 'user') return rec;
    }
  } catch { /* нет файла — нет звена */ } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch { /* уже закрыт */ }
    }
  }
  return null;
}

// Сессия, открытая передачей exit: соседний транскрипт, чей первый промпт —
// план с тем же slug в пределах LINK_MS от отказа. Из нескольких — ближайший.
function childOf(file, exit) {
  const dir = path.dirname(file);
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return null; }
  let best = null;
  for (const name of names) {
    const other = path.join(dir, name);
    if (!name.endsWith('.jsonl') || other === file) continue;
    try { if (fs.statSync(other).mtimeMs < exit.at - LINK_MS) continue; } catch { continue; }
    const first = firstUser(other);
    if (!first?.planContent || (exit.slug && first.slug !== exit.slug)) continue;
    const gap = Math.abs(time(first) - exit.at);
    if (gap <= LINK_MS && (!best || gap < best.gap)) best = { file: other, gap };
  }
  return best?.file ?? null;
}

// Последнее звено цепочки от transcriptPath: { id, title, lastAt, hops } или
// null, если работа этой сессии никуда не передавалась.
export function successorOf(transcriptPath) {
  const seen = new Set([transcriptPath]);
  let file = transcriptPath;
  while (seen.size <= MAX_HOPS) {
    const exit = lastExit(transcriptLines(file));
    const next = exit && childOf(file, exit);
    if (!next || seen.has(next)) break;
    seen.add(next);
    file = next;
  }
  if (file === transcriptPath) return null;
  let title = '';
  let lastAt = 0;
  for (const line of transcriptLines(file)) {
    const rec = parse(line);
    if (rec?.type === 'ai-title' && rec.aiTitle) title = rec.aiTitle;
    lastAt = Math.max(lastAt, time(rec));
  }
  return { id: path.basename(file, '.jsonl'), title, lastAt, hops: seen.size - 1 };
}

// Текст плана ExitPlanMode: tool_input.plan, без него — файл planFilePath.
export function planOf(toolInput) {
  const ti = toolInput || {};
  if (typeof ti.plan === 'string') return ti.plan;
  try { return fs.readFileSync(ti.planFilePath, 'utf8'); } catch { return ''; }
}

// Снимок, а не обычный план: заголовки раздела Snapshot скилла handoff.
// Обычный план, одобренный без очистки, — работа в этой же сессии, не передача.
const isSnapshot = (text) => /^## Состояние/m.test(text) && /^## Дальше/m.test(text);

// Снимок старше — уже не «только что передали», а забытая метка.
const PENDING_TTL_MS = 12 * 3600 * 1000;
const pendingFile = (cwd) => statePath('handoff-pending', `${projectKey(cwd)}.json`);

// Одобренный ExitPlanMode со снимком: метка для следующей сессии корня.
export function markPending({ cwd, sessionId, planPath, plan, now = Date.now() }) {
  if (!planPath || !isSnapshot(plan)) return false;
  return writeJSON(pendingFile(cwd), { repoRoot: repoRootOr(cwd), planPath, sessionId, at: now });
}

// Промпт в сессии, что пометила снимок: работу продолжили здесь, метка не нужна.
export function dropPending(cwd, sessionId) {
  const file = pendingFile(cwd);
  if (readJSON(file, null)?.sessionId !== sessionId) return false;
  try { fs.unlinkSync(file); } catch { /* уже снята */ }
  return true;
}

// Путь снимка для новой сессии корня или null. Метка снимается при любом
// исходе: снимок отдаётся один раз, а удаливший первым при параллельном старте
// двух сессий — единственный получатель.
export function takePending(cwd, sessionId, now = Date.now()) {
  const file = pendingFile(cwd);
  const mark = readJSON(file, null);
  if (!mark || mark.sessionId === sessionId) return null;
  try { fs.unlinkSync(file); } catch { return null; }
  const fresh = now - mark.at >= 0 && now - mark.at < PENDING_TTL_MS;
  if (!fresh || mark.repoRoot !== repoRootOr(cwd) || !fs.existsSync(String(mark.planPath))) return null;
  return mark.planPath;
}

const pad = (n) => String(n).padStart(2, '0');
const stamp = (ms) => {
  const d = new Date(ms);
  return `${pad(d.getDate())}.${pad(d.getMonth() + 1)} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

// Подсказка для открытой через resume сессии: { message } пользователю,
// { context } модели. null — сессия последняя в своей цепочке.
export function resumeHint(transcriptPath) {
  const next = successorOf(transcriptPath);
  if (!next) return null;
  const where = `${next.title ? `«${next.title}», ` : ''}последняя запись ${stamp(next.lastAt)}`
    + (next.hops > 1 ? `, звеньев после этой: ${next.hops}` : '');
  return {
    message: `Работа этой сессии ушла через handoff в другую (${where}). Вернуться: /resume ${next.id}`,
    context: `resume-hint: эту сессию открыли через resume, но её работа передана handoff и продолжилась `
      + `в сессии ${next.id} (${where}). Изменения в дереве после передачи сделаны там, в этой `
      + `переписке их нет. Пользователю показана команда /resume ${next.id}; если он пишет `
      + 'здесь, напомни её одной строкой в первом ответе.',
  };
}
