// Разбор shell-команды для гардов: сегменты, токены, настоящая команда за
// обёртками. Грубый, как и сами гарды: распознаются формы, а не грамматика
// shell. Но формы, которыми команду пишут естественно, — `&`, `( … )`,
// `{ …; }`, `if …; then …`, `$(…)`, обёртка с опциями (`sudo -u root`), —
// разбираются: пропущенная здесь, она проходит мимо всех проверок разом.

import path from 'node:path';

// Сегмент — одна простая команда. piped: читает stdin из пайпа, и путь к файлу
// у неё может лежать в соседнем сегменте (`echo .env | xargs cat`).
// Команды из подстановок `$(…)`, `` `…` ``, `<(…)` идут отдельными сегментами:
// в `echo $(cat .env)` читает не echo, а cat.
export function segments(command) {
  const text = String(command || '');
  const out = [];
  const subs = [];
  let buf = '';
  let quote = null;
  let piped = false;

  const cut = (nextPiped) => {
    const t = buf.trim();
    buf = '';
    if (t) {
      out.push({ text: t, piped });
      piped = nextPiped;
    } else {
      // Пустой сегмент (`a | (b)`, `; ;`) не сбрасывает признак пайпа.
      piped = piped || nextPiped;
    }
  };

  // Подстановка с позиции открывающей скобки: тело уходит отдельной командой,
  // а в текст сегмента остаётся как есть — по нему судят, например, что имя
  // ветки у push вычисляется.
  const takeParen = (open) => {
    let depth = 0;
    let j = open;
    for (; j < text.length; j++) {
      if (text[j] === '(') depth++;
      else if (text[j] === ')' && --depth === 0) break;
    }
    subs.push(text.slice(open + 1, j));
    return j;
  };

  const takeBacktick = (open) => {
    let j = open + 1;
    while (j < text.length && text[j] !== '`') j += text[j] === '\\' ? 2 : 1;
    subs.push(text.slice(open + 1, j));
    return j;
  };

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    const next = text[i + 1];

    // В одинарных кавычках обратный слеш — обычный символ, `'a\'` закрыта.
    if (quote === "'") {
      buf += c;
      if (c === "'") quote = null;
      continue;
    }

    // Подстановка работает и снаружи, и внутри двойных кавычек. `$((` —
    // арифметика, команд в ней нет.
    const subOpen = (c === '$' && next === '(' && text[i + 2] !== '(')
      || (!quote && (c === '<' || c === '>') && next === '(');
    if (subOpen) {
      const end = takeParen(i + 1);
      buf += text.slice(i, end + 1);
      i = end;
      continue;
    }
    if (c === '`') {
      const end = takeBacktick(i);
      buf += text.slice(i, end + 1);
      i = end;
      continue;
    }

    if (quote === '"') {
      if (c === '\\' && i + 1 < text.length) { buf += c + next; i++; continue; }
      buf += c;
      if (c === '"') quote = null;
      continue;
    }

    if (c === '\\' && i + 1 < text.length) { buf += c + next; i++; continue; }
    if (c === '"' || c === "'") { quote = c; buf += c; continue; }

    if ((c === '|' && next === '|') || (c === '&' && next === '&')) { i++; cut(false); continue; }
    if (c === '|') { if (next === '&') i++; cut(true); continue; }
    // Одиночный `&` — фоновый запуск, то есть разделитель. Кроме перенаправлений:
    // `2>&1`, `>&2`, `&>file`.
    if (c === '&' && text[i - 1] !== '>' && text[i - 1] !== '<' && next !== '>') { cut(false); continue; }
    if (c === ';' || c === '\n') { cut(false); continue; }
    // Группа `( … )` и тело функции `f() { … }`. Скобка после `=` — массив
    // (`a=(1 2)`), она часть присваивания.
    if ((c === '(' && text[i - 1] !== '=') || c === ')') { cut(false); continue; }
    buf += c;
  }
  cut(false);

  for (const sub of subs) out.push(...segments(sub));
  return out;
}

export function tokenize(seg) {
  return [...String(seg).matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)].map((m) => m[1] ?? m[2] ?? m[3]);
}

// Слова shell, после которых идёт команда: `then cat .env`, `do cat .env`,
// `! cat .env`, `{ cat .env; }`.
const SHELL_KEYWORDS = new Set(['if', 'then', 'else', 'elif', 'do', 'while', 'until', '!', '{']);

// Обёртки, за которыми стоит настоящая команда, и их опции с аргументом:
// `sudo -u root cat` — команда cat, а не root.
const WRAPPERS = {
  sudo: ['-u', '-g', '-C', '-D', '-h', '-p', '-r', '-t', '-U', '--user', '--group'],
  doas: ['-u', '-C'],
  env: ['-u', '-C', '-S', '--unset', '--chdir', '--split-string'],
  command: [],
  builtin: [],
  exec: ['-a'],
  nohup: [],
  setsid: [],
  time: ['-f', '-o', '--format', '--output'],
  timeout: ['-s', '-k', '--signal', '--kill-after'],
  nice: ['-n', '--adjustment'],
  ionice: ['-c', '-n', '-p', '-P', '-u', '--class', '--classdata'],
  stdbuf: ['-i', '-o', '-e'],
  xargs: ['-a', '-I', '-n', '-P', '-d', '-E', '-L', '-s', '--arg-file', '--delimiter',
    '--max-args', '--max-procs', '--replace'],
};

const ASSIGN_RE = /^[A-Za-z_]\w*=/;
const DURATION_RE = /^\d+(\.\d+)?[smhd]?$/;

// Индекс настоящей команды в токенах; toks.length — команды нет (`sudo env`
// без аргументов, одно присваивание).
export function commandIndex(toks) {
  let i = 0;
  while (i < toks.length) {
    const t = toks[i];
    if (SHELL_KEYWORDS.has(t) || ASSIGN_RE.test(t)) { i++; continue; }
    const name = path.basename(t);
    const opts = WRAPPERS[name];
    if (!opts) break;
    i++;
    while (i < toks.length && toks[i].startsWith('-')) {
      if (toks[i] === '--') { i++; break; }
      if (opts.includes(toks[i])) i++;
      i++;
    }
    if (name === 'timeout' && DURATION_RE.test(toks[i] || '')) i++;
  }
  return i;
}

export function commandName(toks) {
  return path.basename(toks[commandIndex(toks)] || '');
}

// Аргументы после цели: `ssh [опции] host команда…`, `docker exec [опции]
// контейнер команда…`. Опции разбираются только до цели — дальше идёт чужая
// команда со своими флагами (`cat -n .env`).
export function afterTarget(toks, start, argOpts) {
  let i = start;
  while (i < toks.length && toks[i].startsWith('-') && toks[i] !== '--') {
    if (argOpts.includes(toks[i])) i++;
    i++;
  }
  if (toks[i] === '--') i++;
  return toks.slice(i + 1);
}
