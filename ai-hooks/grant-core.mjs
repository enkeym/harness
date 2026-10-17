// Разрешения из промпта — общее ядро. Пользователь сам назвал действие в
// текущем промпте («сделай МР», «удали», «откати», «задеплой») — вопрос
// security-guard на это действие не задаётся: согласие уже дано словами.
//
// Источник — последний промпт человека в транскрипте сессии (`origin.kind:
// human`): своего файла состояния нет, выдать согласие себе скриптом агенту
// нечем. План после handoff (`auto-continuation`), ответы меню и уведомления —
// не промпт человека. Набор живёт до следующего промпта сам собой. deny не
// снимается ничем; ask без категории (секреты в выводе, `env`, ssh, sudo,
// передача наружу, внешняя БД) спрашивается всегда.
//
// Словарь — основы слов, без разбора смысла: «удали tmp-файлы» откроет и
// `rm -rf .`. Поэтому корень и домашний каталог категории не имеют вовсе.

import { transcriptLines } from './context-core.mjs';

// Категория → основы отдельных слов (начало слова после нормализации).
const WORD_STEMS = {
  push: [/^(за)?пуш/, /^push/],
  // gh/glab pr|mr create|merge. Слово «МР» даёт и push: МР без push не бывает.
  mr: [/^(мр|mr|pr)$/, /^мр(ка|ку|ки|ы)$/, /^(с)?мер(д)?ж/, /^merge$/],
  'push-force': [/^форс/, /^force/],
  // «удал» без «удален…»: «удалённый репозиторий» — не просьба удалить.
  delete: [/^удал(?!ен)/, /^снес/, /^сотри/, /^стереть/, /^(по)?чист[иь]/, /^очист/, /^вычист/, /^delete/, /^remove/, /^rm$/,
    /^clean/, /^prune/, /^wipe/],
  revert: [/^откат/, /^сбро[сш]/, /^выкин/, /^revert/, /^reset/, /^rollback/, /^discard/],
  deploy: [/^(за)?депло/, /^выкат/, /^раскат/, /^(о)?публик/, /^(за)?релиз/, /^выложи/, /^deploy/, /^publish/,
    /^release/],
  migrate: [/^(с)?мигр/, /^migrat/, /^накат/],
};

// Категория → фразы целиком (по нормализованному тексту клаузы).
const PHRASES = {
  mr: [/(мерж|мердж|merge|пулл?|pull)[\s-]*(реквест|request)/],
  'push-force': [/пере(за)?пиши\s+историю/, /rewrite\s+history/],
  // `--delete`, `:ветка`, а с ними `--all`/`--mirror` и шаблон `*`.
  'push-delete': [/(удал\S*|снес\S*|delete|remove)\s+(\S+\s+)?(ветк|branch)/, /(все|всех|all)\s+(\S+\s+)?(ветк|branch)/,
    /mirror|зеркал/],
};

// Что следует из категории: МР — это ещё и push.
const IMPLIES = { mr: ['push'] };

const NEG_BEFORE = new Set(['не', 'без', 'нельзя', 'никаких', 'ничего', 'don', 'dont', 'not', 'no', 'never', 'without']);
const NEG_AFTER_RE = /^(надо|нужно|стоит|требуется|смей|вздумай)/;
const NEG_WINDOW = 3;

// Вставки не говорят за пользователя: блок ```, `<pasted_content>` и строки цитаты `>`.
export function ownWords(prompt) {
  return String(prompt || '')
    .replace(/```[\s\S]*?(```|$)/g, '\n')
    .replace(/<pasted_content\b[\s\S]*?(<\/pasted_content>|$)/g, '\n')
    .split('\n')
    .filter((line) => !/^\s*>/.test(line))
    .join('\n');
}

function normalize(text) {
  return text.toLowerCase().replace(/ё/g, 'е');
}

// Клаузы: отрицание из одной («не трогай main») не гасит слово другой («и запушь»).
function clauses(text) {
  return normalize(text).split(/[.,;:!?()\n]+|\s(?:и|но|а|потом|затем|then|and|but)\s/);
}

const wordsOf = (clause) => clause.match(/[\p{L}\p{N}]+/gu) || [];

function negatedAt(words, i) {
  for (let k = Math.max(0, i - NEG_WINDOW); k < i; k++) if (NEG_BEFORE.has(words[k])) return true;
  // «пушить не надо», «push not needed»; «запушь, не забудь» — другая клауза.
  const [a, b] = words.slice(i + 1, i + 3);
  return a === 'нельзя' || a === 'not' || (a === 'не' && NEG_AFTER_RE.test(b || ''));
}

// Фраза в отрицании: «не удаляй ветку», «без форс пуша».
function phraseNegated(clause, index) {
  const before = wordsOf(clause.slice(0, index));
  return before.slice(-NEG_WINDOW).some((w) => NEG_BEFORE.has(w));
}

// Промпт → отсортированный список категорий.
export function grantsIn(prompt) {
  const cats = new Set();
  for (const clause of clauses(ownWords(prompt))) {
    const words = wordsOf(clause);
    words.forEach((word, i) => {
      for (const [cat, stems] of Object.entries(WORD_STEMS)) {
        if (stems.some((re) => re.test(word)) && !negatedAt(words, i)) cats.add(cat);
      }
    });
    for (const [cat, list] of Object.entries(PHRASES)) {
      for (const re of list) {
        const m = clause.match(re);
        if (m && !phraseNegated(clause, m.index)) cats.add(cat);
      }
    }
  }
  for (const cat of [...cats]) for (const extra of IMPLIES[cat] || []) cats.add(extra);
  return [...cats].sort();
}

// Текст последнего промпта человека в транскрипте; нет такого — ''.
export function lastPrompt(transcriptPath) {
  const lines = transcriptPath ? transcriptLines(transcriptPath) : [];
  for (let i = lines.length - 1; i >= 0; i--) {
    let e;
    try { e = JSON.parse(lines[i]); } catch { continue; }
    if (e?.type !== 'user' || e.isMeta || e.origin?.kind !== 'human') continue;
    const c = e.message?.content;
    if (typeof c === 'string') return c;
    return Array.isArray(c) ? c.filter((b) => b?.type === 'text').map((b) => b.text).join('\n') : '';
  }
  return '';
}

export function isGranted(transcriptPath, cat) {
  return Boolean(cat) && grantsIn(lastPrompt(transcriptPath)).includes(cat);
}
