// Размытый промпт: длинный, из нескольких фраз и без якоря — пути, символа,
// блока кода, текста ошибки, ссылки, вставки. Такой промпт берёт в работу
// task-brief, но строку его триггера в таблице core.md модель пропускает, и
// задачу без цели и места начинают угадывать. Здесь — напоминание одной
// строкой до первого действия.
//
// Решение — по форме текста, без модели и сети: хук на каждом промпте не может
// стоить секунд. Ошибка в обе стороны дешёвая: лишнее срабатывание — одна
// строка контекста, пропуск — то же, что без хука. Промпт не переписывается:
// UserPromptSubmit умеет только добавить контекст, и копия рядом с оригиналом
// окно раздула бы, а не сжала.

export const LOOSE_MIN_CHARS = 400;
export const LOOSE_MIN_PHRASES = 3;
// Слов во фрагменте, чтобы он считался фразой, а не обрывком списка.
const PHRASE_MIN_WORDS = 3;

const SLASH_COMMAND_RE = /^\s*\//;
const PHRASE_SPLIT_RE = /[.!?…]+\s+|\n+/;
const FILE_EXT = 'm?[jt]sx?|json|ya?ml|toml|md|py|ps1|sh|go|rs|java|kt|cs|sql|prisma|css|scss|html|env';

// Любое совпадение — промпт уже называет место или факт, угадывать нечего.
const ANCHOR_RES = [
  /```|`[^`\n]+`/, // код, имя в обратных кавычках
  /<pasted_content|<command-name>/, // вставка, вызов команды
  /https?:\/\//, // ссылка
  // (?<![\w-]) — совпадение только с начала токена: иначе слово на 40k символов
  // перебирается с каждой позиции, квадратично, секунды на промпт.
  new RegExp(`(?:^|[\\s("'«])(?:~|\\.{1,2})?\\/[\\w.-]+|(?<![\\w-])[\\w-]+(?:\\/[\\w.-]+){2,}|(?<![\\w-])[\\w-]+\\.(?:${FILE_EXT})\\b`, 'i'), // путь, файл
  /\b[a-z]+(?:[A-Z][a-z0-9]*)+\b|\b[a-z][a-z0-9]*_[a-z0-9_]+\b/, // camelCase, snake_case
  /\b\w*(?:Error|Exception)\b|Traceback|\bat \S+:\d+|exit code \d+/, // ошибка, стек
];

export const LOOSE_PROMPT_HINT = 'prompt-shape: промпт длинный и без якоря — ни файла, ни символа, ни '
  + 'ошибки, ни кода. Нет цели, места или критерия готовности — загрузи task-brief до первого '
  + 'действия (спор об одной идее — его раздел Challenge). Вопрос без правок или всё ясно из кода — '
  + 'отвечай как есть.';

function phrases(text) {
  return text.split(PHRASE_SPLIT_RE).filter((f) => f.trim().split(/\s+/).length >= PHRASE_MIN_WORDS).length;
}

export function isLoosePrompt(prompt) {
  if (typeof prompt !== 'string') return false;
  const text = prompt.trim();
  if (text.length < LOOSE_MIN_CHARS || SLASH_COMMAND_RE.test(text)) return false;
  if (ANCHOR_RES.some((re) => re.test(text))) return false;
  return phrases(text) >= LOOSE_MIN_PHRASES;
}
