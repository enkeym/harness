// Заглушка `unchanged: true` у tokensave_read. Кэш чтений tokensave (таблица
// read_cache в БД проекта) пишется с session_id = 'global' и живёт между
// сессиями: повторное чтение неизменённого файла возвращает не текст, а
// заглушку — даже если в контексте текущей сессии этого файла нет (новая
// сессия, /clear, сжатие контекста). Выключить кэш в tokensave 7.12 нечем,
// поэтому текст подставляем с диска: файл не менялся — значит, на диске ровно
// то, что tokensave отдал бы.
//
// Восстанавливаются режимы full и lines. map и signatures строятся из графа,
// с диска их не повторить — такая заглушка остаётся как есть.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const LINES_RE = /^\s*(\d+)\s*(?:-\s*(\d+)\s*)?$/;
const HEADER_RE = /^([a-z_]+):\s*(.*)$/;

// format: json — объект; format: text (по умолчанию) — строки `ключ: значение`,
// пустая строка, тело. У заглушки тела нет.
const isJson = (text) => text.trimStart().startsWith('{');

// Корень, от которого tokensave считает относительные пути, — тот же, что
// выбирает bin/mcp-serve.sh:find_root: ближайший вверх каталог с
// .tokensave/tokensave.db, $HOME не в счёт. Не нашли → null.
function indexRoot(start) {
  const home = os.homedir();
  let dir = path.resolve(start);
  while (dir !== home) {
    if (fs.existsSync(path.join(dir, '.tokensave', 'tokensave.db'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}

// Заглушка из текста ответа: JSON с unchanged === true или текстовый
// заголовок со строкой `unchanged: true`. Иначе null.
function parseStub(text) {
  if (typeof text !== 'string' || !text.includes('unchanged')) return null;
  if (isJson(text)) {
    try {
      const obj = JSON.parse(text);
      return obj && obj.unchanged === true ? obj : null;
    } catch {
      return null;
    }
  }
  const fields = {};
  for (const line of text.split('\n')) {
    if (!line.trim()) break; // дальше тело — значит, ответ не заглушка
    const m = HEADER_RE.exec(line);
    if (!m) return null;
    fields[m[1]] = m[2].trim();
  }
  return fields.unchanged === 'true' ? fields : null;
}

// Диапазон 'A-B' или 'A', 1-based, включительно — как у tokensave_read.
function sliceLines(text, spec) {
  const m = LINES_RE.exec(String(spec || ''));
  if (!m) return null;
  const from = Number(m[1]);
  const to = m[2] ? Number(m[2]) : from;
  if (from < 1 || to < from) return null;
  return text.split('\n').slice(from - 1, to).join('\n');
}

// Текст, который tokensave_read вернул бы вместо заглушки. graph_branch —
// чтение другой ветки: на диске её файлов нет, восстанавливать нечего.
function stubBody(stub, toolInput, start) {
  const ti = toolInput || {};
  if (ti.graph_branch) return null;
  const mode = stub.mode || ti.mode || 'full';
  if (mode !== 'full' && mode !== 'lines') return null;

  const rel = String(ti.file || stub.file || '');
  if (!rel) return null;
  const root = typeof ti.graph_root === 'string' ? ti.graph_root : indexRoot(start);
  if (!root && !path.isAbsolute(rel)) return null;
  const file = path.resolve(root || '/', rel);

  const text = fs.readFileSync(file, 'utf8');
  return mode === 'full' ? text : sliceLines(text, ti.lines);
}

// Текст заглушки без `unchanged` и с телом — в формате самой заглушки. JSON правим
// строкой, а не пересобираем объект: mtime_ns больше 2^53, и JSON.parse → stringify
// портит его младшие цифры.
function withBody(text, body) {
  if (!isJson(text)) {
    const header = text.split('\n').filter((line) => line.trim() && !line.startsWith('unchanged:'));
    return `${header.join('\n')}\n\n${body}`;
  }
  const out = text
    .replace(/"unchanged"\s*:\s*true\s*,\s*|,\s*"unchanged"\s*:\s*true/, '')
    .replace(/\s*\}\s*$/, () => `,\n  "body": ${JSON.stringify(body)}\n}`); // функция: `$&` в теле — не шаблон
  JSON.parse(out); // битая правка → исключение, хук промолчит
  return out;
}

// Ответ MCP — массив блоков [{type:'text', text}]; встречается и объект
// { content: [...] }. Возвращаем ту же форму с подменённым блоком заглушки
// или null, если подменять нечего.
export function refillResponse(response, toolInput, start) {
  const blocks = Array.isArray(response) ? response
    : Array.isArray(response?.content) ? response.content
      : null;
  if (!blocks) return null;

  const idx = blocks.findIndex((b) => b?.type === 'text' && parseStub(b.text));
  if (idx < 0) return null;
  const stub = parseStub(blocks[idx].text);
  const body = stubBody(stub, toolInput, start);
  if (body === null) return null;

  const next = blocks.slice();
  next[idx] = { ...blocks[idx], text: withBody(blocks[idx].text, body) };
  return Array.isArray(response) ? next : { ...response, content: next };
}
