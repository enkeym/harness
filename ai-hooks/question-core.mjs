// Вопрос пользователю текстом в конце ответа. Правило core.md (Working style):
// вопрос — только через меню (AskUserQuestion), иначе он висит в конце ответа,
// пока человек его не заметит. Правило модель нарушала, проверки не было —
// теперь Stop-хук не даёт завершить такой ход.
//
// Смотрит только последний ход: от последней реплики человека до конца
// транскрипта. Ход, в котором уже был AskUserQuestion или ExitPlanMode, не
// судится — вопрос уже задан меню. Код в ``` и `…`, цитаты `>` не считаются:
// `?` в них — не вопрос пользователю.

import fs from 'node:fs';

// Инструменты, которые сами задают вопрос человеку.
const MENU_TOOLS = new Set(['AskUserQuestion', 'ExitPlanMode']);

const FENCE_RE = /^\s*(```|~~~)/;
const QUOTE_RE = /^\s*>/;
const INLINE_CODE_RE = /`[^`\n]*`/g;
// `?` в конце строки; после него — только разметка и закрывающие знаки.
const QUESTION_END_RE = /\?[:\s*_)\]»"'“”]*$/;
// Пункт списка: `1.`, `2)`, `-`, `*`, `•`, `а)`/`a)`.
const LIST_ITEM_RE = /^\s*(?:\d+[.)]|[-*•]|[a-zа-я]\))\s+\S/i;
// Столько пунктов подряд в хвосте — уже список вариантов.
const MIN_OPTIONS = 2;

export const REASON = 'Ответ кончается вопросом пользователю текстом. Правило core.md: '
  + 'вопрос — только через AskUserQuestion, варианты — в options, рекомендуемый первым. '
  + 'Задай его сейчас через AskUserQuestion. Вопрос риторический и ответа не ждёт — '
  + 'перепиши концовку без вопроса.';

function readLines(file) {
  try {
    return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

// Реплика человека открывает ход: не служебная вставка и не результат инструмента.
function isPrompt(rec) {
  if (rec.type !== 'user' || rec.isMeta) return false;
  const content = rec.message?.content;
  if (typeof content === 'string') return true;
  return Array.isArray(content) && !content.some((b) => b?.type === 'tool_result');
}

// Последний ход: текст последнего текстового блока ассистента и был ли вызов меню.
export function lastTurn(lines) {
  let text = null;
  let menu = false;
  for (let i = lines.length - 1; i >= 0; i--) {
    let rec;
    try { rec = JSON.parse(lines[i]); } catch { continue; }
    if (isPrompt(rec)) break;
    if (rec.type !== 'assistant' || !Array.isArray(rec.message?.content)) continue;
    for (const block of rec.message.content) {
      if (block?.type === 'tool_use' && MENU_TOOLS.has(block.name)) menu = true;
    }
    if (text === null) {
      const blocks = rec.message.content.filter((b) => b?.type === 'text' && b.text?.trim());
      if (blocks.length) text = blocks[blocks.length - 1].text;
    }
  }
  return { text, menu };
}

// Строки прозы: без код-блоков, инлайн-кода и цитат, пустые убраны.
function proseLines(text) {
  const out = [];
  let fenced = false;
  for (const line of String(text).split('\n')) {
    if (FENCE_RE.test(line)) { fenced = !fenced; continue; }
    if (fenced || QUOTE_RE.test(line)) continue;
    const prose = line.replace(INLINE_CODE_RE, '').trim();
    if (prose) out.push(prose);
  }
  return out;
}

// Вопрос в конце: последняя строка прозы кончается `?`, или хвост — список из
// MIN_OPTIONS+ пунктов, а строка перед ним — вопрос.
export function endsWithQuestion(text) {
  const lines = proseLines(text);
  if (!lines.length) return false;
  if (QUESTION_END_RE.test(lines[lines.length - 1])) return true;
  let i = lines.length;
  while (i > 0 && LIST_ITEM_RE.test(lines[i - 1])) i--;
  const items = lines.length - i;
  return items >= MIN_OPTIONS && i > 0 && QUESTION_END_RE.test(lines[i - 1]);
}

// Вход Stop → причина блока или null. Второй Stop подряд (stop_hook_active)
// пропускается: модель уже получила причину, второй блок — это петля.
export function questionVerdict(input) {
  if (!input || input.stop_hook_active || !input.transcript_path) return null;
  const { text, menu } = lastTurn(readLines(input.transcript_path));
  if (menu) return null;
  // last_assistant_message свежее транскрипта: последняя запись может не успеть на диск.
  const last = typeof input.last_assistant_message === 'string' ? input.last_assistant_message : text;
  return last && endsWithQuestion(last) ? REASON : null;
}
