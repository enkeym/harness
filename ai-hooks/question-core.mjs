// Вопрос пользователю текстом в конце ответа. Правило core.md (Working style):
// вопрос — только через меню (AskUserQuestion), иначе он висит в конце ответа,
// пока человек его не заметит. Правило модель нарушала, проверки не было —
// теперь Stop-хук не даёт завершить такой ход.
//
// Смотрит только последний ход: от последней реплики человека до конца
// транскрипта. Ход, в котором уже был AskUserQuestion или ExitPlanMode, не
// судится — вопрос уже задан меню. Код в ``` и `…`, цитаты `>` и заголовки `#`
// не считаются: `?` в них — не вопрос пользователю.
//
// Вопрос без `?` тоже вопрос: «Как скажете „ок“ — закоммичу» ждёт решения так же,
// как «Коммитить?», и висит так же. Такой случай прошёл мимо хука — отсюда
// AWAIT_RE и OPTIONS_HEAD_RE.
//
// Раньше текста судится порог контекста — по мерке context-core:stopNoticeDue
// (HAND один раз, HARD каждый ход): совет о передаче модель пропускала.
// Ход с правкой без вопроса не блокируется: блок на каждой правке держал ходы,
// где спрашивать было нечего, — вопрос ищут только регэкспы.

import { contextUsed, level, noticeText, isWork, sessionWorked, stopNoticeDue, transcriptLines } from './context-core.mjs';

// Инструменты, которые сами задают вопрос человеку.
const MENU_TOOLS = new Set(['AskUserQuestion', 'ExitPlanMode']);

const FENCE_RE = /^\s*(```|~~~)/;
const QUOTE_RE = /^\s*>/;
const INLINE_CODE_RE = /`[^`\n]*`/g;
const HEADING_RE = /^#{1,6}\s/;
// `?` в конце строки; после него — только разметка, закрывающие знаки, эмодзи.
const QUESTION_END_RE = /\?[:!\s*_)\]»"'“”\p{Extended_Pictographic}\u{FE0F}\u{200D}]*$/u;
// `?` в середине строки, дальше новое предложение: «Какой метод показывает /status?
// По нему можно сузить причину.» (a19ce8c3) — пояснение в той же строке.
const QUESTION_MID_RE = /\?[*_)\]»"'“”]*\s+[\p{Lu}]/u;
// Открытые вопросы утверждением: «Открытыми остаются три вопроса: …» (87ab5ef7) —
// ответа ждут так же, но без `?` и часто не последним абзацем. Без «открыт»
// («Остался вопрос к X: не менялся») это чаще отчёт, чем вопрос.
const OPEN_RE = /(?<![\p{L}\p{N}])(?:открыт\p{L}*\s+(?:[\p{L}\p{N}]+\s+){0,2}вопрос|вопрос\p{L}*\s+(?:[\p{L}\p{N}]+\s+){0,2}открыт|open questions?(?![\p{L}\p{N}]))/iu;
// «Открытых вопросов нет», «вопрос из плана закрылся» — отчёт, что ждать нечего.
const OPEN_CLOSED_RE = /(?<![\p{L}\p{N}])(?:нет|не остал\p{L}*|закрыл\p{L}*|снят\p{L}*|решён|решен\p{L}*|none)(?![\p{L}\p{N}])/iu;
// Столько последних абзацев проверяет OPEN_RE.
const OPEN_PARAS = 2;
// Цитируемое в кавычках — не слова автора: «Жду вашего „ок“» судится без „ок“.
const QUOTED_RE = /«[^»]*»|„[^“”]*[“”]|"[^"]*"|“[^”]*”/g;
// Ожидание решения пользователя в форме утверждения. «Подтвердите UAC» — просьба
// нажать кнопку, пока фоновая установка ждёт, а не решение: меню там лишнее.
const AWAIT_RE = new RegExp('(?<![\\p{L}\\p{N}])(?:'
  + 'как скажете|скажите|напишите|дайте знать|подтвердите(?! uac)'
  + '|жду (?:вашего|вашей|ваш|ответа|решения|подтверждения(?! uac)|отмашки|команды|ок)'
  + '|если (?:согласны|хотите|не против|скажете)'
  + '|если (?:нужно|надо)[^.]*могу'
  + '|решать вам|на ваше усмотрение|выбор за вами'
  + '|let me know|should i|shall i|want me to|do you want|would you like'
  + "|if you(?:'d)? (?:like|want|prefer|agree)"
  + ')(?![\\p{L}\\p{N}])', 'iu');
// Варианты без `?`: «Варианты: 1) … 2) …», «Можно A или B».
const OPTIONS_HEAD_RE = /^(?:варианты|на выбор|options)(?![\p{L}\p{N}])|^можно(?! было)\s.+\sили\s/iu;
// Пункт списка: `1.`, `2)`, `-`, `*`, `•`, `а)`/`a)`.
const LIST_ITEM_RE = /^\s*(?:\d+[.)]|[-*•]|[a-zа-я]\))\s+\S/i;
// Столько пунктов подряд в хвосте — уже список вариантов.
const MIN_OPTIONS = 2;

export const REASON = 'Ответ кончается вопросом пользователю или ожиданием его решения текстом. '
  + 'Правило core.md: вопрос — только через AskUserQuestion, варианты — в options, '
  + 'рекомендуемый первым. Задай его сейчас через AskUserQuestion. Вопрос риторический '
  + 'и ответа не ждёт — перепиши концовку без него.';

export const CONTEXT_REASON = 'Ход кончился без меню, а контекст за порогом.';

// Реплика человека открывает ход: не служебная вставка и не результат инструмента.
function isPrompt(rec) {
  if (rec.type !== 'user' || rec.isMeta) return false;
  const content = rec.message?.content;
  if (typeof content === 'string') return true;
  return Array.isArray(content) && !content.some((b) => b?.type === 'tool_result');
}

// Последний ход: текст последнего текстового блока ассистента, был ли вызов меню
// и была ли работа — правка в репозитории или коммит, как её считает context-core.
export function lastTurn(lines, cwd) {
  let text = null;
  let menu = false;
  let worked = false;
  for (let i = lines.length - 1; i >= 0; i--) {
    let rec;
    try { rec = JSON.parse(lines[i]); } catch { continue; }
    if (isPrompt(rec)) break;
    if (rec.type !== 'assistant' || !Array.isArray(rec.message?.content)) continue;
    for (const block of rec.message.content) {
      if (block?.type !== 'tool_use') continue;
      if (MENU_TOOLS.has(block.name)) menu = true;
      else if (!worked && isWork(block.name, block.input, cwd)) worked = true;
    }
    if (text === null) {
      const blocks = rec.message.content.filter((b) => b?.type === 'text' && b.text?.trim());
      if (blocks.length) text = blocks[blocks.length - 1].text;
    }
  }
  return { text, menu, worked };
}

// Строки прозы с номером абзаца: без код-блоков, инлайн-кода, цитат и
// заголовков. Пустая строка, код-блок и цитата закрывают абзац.
function proseLines(text) {
  const out = [];
  let fenced = false;
  let para = 0;
  for (const line of String(text).split('\n')) {
    if (FENCE_RE.test(line)) { fenced = !fenced; para++; continue; }
    if (fenced) continue;
    if (!line.trim() || QUOTE_RE.test(line)) { para++; continue; }
    const prose = line.replace(INLINE_CODE_RE, '').trim();
    if (prose && !HEADING_RE.test(prose)) out.push({ text: prose, para });
  }
  return out;
}

const asks = (line) => QUESTION_END_RE.test(line)
  || QUESTION_MID_RE.test(line)
  || AWAIT_RE.test(line.replace(QUOTED_RE, ''))
  || OPTIONS_HEAD_RE.test(line);

// Строка, на которой ответ ждёт пользователя, или null. Судится последний абзац
// целиком — пояснение после вопроса его не прячет; и хвост из MIN_OPTIONS+
// пунктов списка, если строка перед ним — вопрос или заголовок вариантов;
// открытые вопросы — в OPEN_PARAS последних абзацах.
export function pendingQuestion(text) {
  const lines = proseLines(text);
  if (!lines.length) return null;
  const lastPara = lines[lines.length - 1].para;
  const hit = lines.find((l) => l.para === lastPara && asks(l.text));
  if (hit) return hit.text;
  const tailParas = [...new Set(lines.map((l) => l.para))].slice(-OPEN_PARAS);
  const open = lines.find((l) => {
    const prose = l.text.replace(QUOTED_RE, '');
    return tailParas.includes(l.para) && OPEN_RE.test(prose) && !OPEN_CLOSED_RE.test(prose);
  });
  if (open) return open.text;
  let i = lines.length;
  while (i > 0 && LIST_ITEM_RE.test(lines[i - 1].text)) i--;
  if (lines.length - i >= MIN_OPTIONS && i > 0 && asks(lines[i - 1].text)) return lines[i - 1].text;
  return null;
}

// Вход Stop → причина блока или null. Второй Stop подряд (stop_hook_active)
// пропускается: модель уже получила причину, второй блок — это петля.
//
// Порядок: порог контекста (HAND один раз за сессию, HARD каждый ход; SOFT
// не блокирует), затем текст.
export function questionVerdict(input) {
  if (!input || input.stop_hook_active || !input.transcript_path) return null;
  const { text, menu, worked } = lastTurn(transcriptLines(input.transcript_path), input.cwd);
  if (menu) return null;
  const used = contextUsed(input.transcript_path);
  const stage = level(used?.tokens);
  const didWork = worked || sessionWorked(input.session_id);
  if (stage && stopNoticeDue(input.session_id, stage, didWork)) {
    return `${CONTEXT_REASON} ${noticeText(stage, used.tokens, { worked: didWork })}`;
  }
  // last_assistant_message свежее транскрипта: последняя запись может не успеть на диск.
  const last = typeof input.last_assistant_message === 'string' ? input.last_assistant_message : text;
  const line = last ? pendingQuestion(last) : null;
  return line ? `${REASON} Сработало на строке: «${line.slice(0, 200)}».` : null;
}
