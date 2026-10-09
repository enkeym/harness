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
//
// keepHeredoc: тело heredoc дописывается в текст сегмента с `<<`, а не
// разбирается построчно. Нужно гарду интерпретаторов: в `node <<EOF … EOF`
// тело — код node, и путь внутри него принадлежит сегменту node. Остальным
// гардам нужен построчный разбор: тело `bash <<EOF` — команды, а тело
// `cat > README.md <<EOF` — не аргументы cat.
export function segments(command, { keepHeredoc = false } = {}) {
  const text = String(command || '');
  const out = [];
  const subs = [];
  // Heredoc текущей строки: терминатор и сегмент, которому достанется тело.
  let heredocs = [];
  let buf = '';
  let quote = null;
  let piped = false;

  const cut = (nextPiped) => {
    const t = buf.trim();
    buf = '';
    if (t) {
      const seg = { text: t, piped };
      out.push(seg);
      for (const h of heredocs) h.owner ??= seg;
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

  // `(( … ))` и `$(( … ))` — арифметика: `;` в ней не разделитель
  // (`for ((i=0; i<5; i++))`), команды — только в подстановках. Конец — `))`
  // подряд; иначе bash читает `((cat .env) )` как две вложенные группы, и это
  // команда. Скобки в кавычках не считаются: `(( a == "))" ))` целиком
  // арифметика, а подстановка в двойных — команда. Индекс второй `)` или -1.
  const takeArith = (open) => {
    const mark = subs.length;
    let depth = 0;
    let innerEnd = -1;
    let dq = false;
    for (let j = open; j < text.length; j++) {
      const c = text[j];
      if (c === '\\') { j++; continue; }
      if (c === '$' && text[j + 1] === '(' && text[j + 2] !== '(') { j = takeParen(j + 1); continue; }
      if (c === '`') { j = takeBacktick(j); continue; }
      if (c === '"') { dq = !dq; continue; }
      if (dq) continue;
      if (c === "'") { j = quoteEnd(text, j); continue; }
      if (c === '(') depth++;
      else if (c === ')') {
        if (--depth === 1) innerEnd = j;
        if (depth === 0) {
          if (j === innerEnd + 1) return j;
          break;
        }
      }
    }
    subs.length = mark;
    return -1;
  };
  let inTest = false;

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

    // `[[ … ]]` — условие: `&&`, `||`, `( )` в нём не делят команду, а `<`/`>`
    // сравнивают строки. Подстановки внутри разбираются выше, как обычно.
    // Только в позиции команды: в `echo [[ ; cat .env` это слово echo, и
    // `cat .env` исполняется. Перевод строки условие закрывает.
    if (inTest && c !== '\n') {
      if (c === ']' && next === ']') { inTest = false; buf += ']]'; i++; } else buf += c;
      continue;
    }
    inTest = false;
    if (c === '[' && next === '[' && keywordLead(buf) === buf.length) {
      inTest = true;
      buf += '[[';
      i++;
      continue;
    }
    if (c === '(' && next === '(') {
      const end = takeArith(i);
      if (end !== -1) {
        buf += text.slice(i, end + 1);
        i = end;
        continue;
      }
    }

    if ((c === '|' && next === '|') || (c === '&' && next === '&')) { i++; cut(false); continue; }
    if (c === '|') { if (next === '&') i++; cut(true); continue; }
    // Одиночный `&` — фоновый запуск, то есть разделитель. Кроме перенаправлений:
    // `2>&1`, `>&2`, `&>file`.
    if (c === '&' && text[i - 1] !== '>' && text[i - 1] !== '<' && next !== '>') { cut(false); continue; }
    // `<<EOF`, `<<-'EOF'`, `<<\EOF`; `<<<` — here-string, тела у него нет.
    if (keepHeredoc && c === '<' && next === '<' && text[i - 1] !== '<' && text[i + 2] !== '<') {
      const m = text.slice(i).match(/^<<-?\s*(?:'(\w+)'|"(\w+)"|\\?(\w+))/);
      if (m) {
        heredocs.push({ term: m[1] ?? m[2] ?? m[3], owner: null });
        buf += m[0];
        i += m[0].length - 1;
        continue;
      }
    }
    if (c === '\n' && heredocs.length) {
      cut(false);
      // Тела идут подряд в порядке `<<` на строке, каждое до своего терминатора.
      for (const h of heredocs) {
        const rest = text.slice(i + 1);
        const end = rest.match(new RegExp(`(^|\\n)\\t*${h.term}(?=\\n|$)`));
        const taken = end ? end.index + end[0].length : rest.length;
        if (h.owner) h.owner.text += '\n' + rest.slice(0, taken);
        i += taken;
      }
      heredocs = [];
      continue;
    }
    if (c === ';' || c === '\n') { cut(false); continue; }
    // Группа `( … )` и тело функции `f() { … }`. Скобка после `=` — массив
    // (`a=(1 2)`), она часть присваивания.
    if ((c === '(' && text[i - 1] !== '=') || c === ')') { cut(false); continue; }
    buf += c;
  }
  cut(false);

  for (const sub of subs) out.push(...segments(sub, { keepHeredoc }));
  return out;
}

// Конец строки в кавычках с позиции открывающей кавычки. Внутри двойных `$(…)` —
// своя команда со своими кавычками: в `"$(jq '.a=="b"' f)"` строку закрывает
// только последняя `"`. Незакрытая строка тянется до конца текста.
export function quoteEnd(text, open) {
  const q = text[open];
  for (let j = open + 1; j < text.length; j++) {
    if (q === "'") { if (text[j] === "'") return j; continue; }
    if (text[j] === '\\') { j++; continue; }
    if (text[j] === '$' && text[j + 1] === '(') { j = parenEnd(text, j + 1); continue; }
    if (text[j] === '"') return j;
  }
  return text.length;
}

// Закрывающая скобка подстановки с позиции открывающей; скобки в кавычках не
// считаются.
function parenEnd(text, open) {
  let depth = 0;
  for (let j = open; j < text.length; j++) {
    const c = text[j];
    if (c === "'" || c === '"') j = quoteEnd(text, j);
    else if (c === '(') depth++;
    else if (c === ')' && --depth === 0) return j;
  }
  return text.length;
}

// Подстановка `$(…)`, `<(…)`, `>(…)` — одно слово, как и в shell: её тело
// разбирает segments отдельным сегментом, а здесь флаги из него не должны
// достаться внешней команде (`grep -f <(jq -r …)` — это не `grep -r`).
// Скобки считаются только вне кавычек: `$(echo ")")` закрыта один раз.
export function tokenize(seg) {
  const out = [];
  let depth = 0;
  for (const m of String(seg).matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)) {
    const t = m[1] ?? m[2] ?? m[3];
    const bare = m[3] ?? '';
    const inside = depth > 0;
    if (inside) out[out.length - 1] += ' ' + t;
    else out.push(t);
    if (inside || /[$<>]\(/.test(bare)) {
      depth = Math.max(0, depth + (bare.match(/\(/g) || []).length - (bare.match(/\)/g) || []).length);
    }
  }
  return out;
}

// Слова shell, после которых идёт команда: `then cat .env`, `do cat .env`,
// `! cat .env`, `{ cat .env; }`.
const SHELL_KEYWORDS = new Set(['if', 'then', 'else', 'elif', 'do', 'while', 'until', '!', '{']);

// Длина ведущих пробелов и ключевых слов: с этой позиции начинается команда.
function keywordLead(text) {
  let at = 0;
  for (const m of String(text).matchAll(/\s*(\S+)\s+/gy)) {
    if (!SHELL_KEYWORDS.has(m[1])) break;
    at = m.index + m[0].length;
  }
  return at + text.slice(at).match(/^\s*/)[0].length;
}

// Позиция `closer` вне кавычек или -1.
function closeOutsideQuotes(text, from, closer) {
  for (let i = from, quote = null; i < text.length; i++) {
    const c = text[i];
    if (c === '\\' && quote !== "'") { i++; continue; }
    if (quote) { if (c === quote) quote = null; }
    else if (c === '"' || c === "'") quote = c;
    else if (text.startsWith(closer, i)) return i;
  }
  return -1;
}

// `[[ … ]]` и `(( … ))` в позиции команды, `$(( … ))` вне кавычек — сравнение
// и арифметика: `<`/`>` в них не перенаправление. Перенаправления гарды ищут
// в тексте без них. Где угодно вырезать нельзя: в `xargs echo "[[" < .env "]]"`
// это строки, и чтение спряталось бы. Незакрытое условие остаётся как есть.
export function dropConditionals(seg) {
  const text = String(seg);
  let i = keywordLead(text);
  // `for ((i=0; i<n; i++))` — `for` не ключевое слово перед командой, а заголовок.
  i += text.slice(i).match(/^for\s*(?=\(\()/)?.[0].length ?? 0;
  let out = text.slice(0, i);
  const opener = text.slice(i, i + 2);
  const close = opener === '[[' || opener === '((' ? closeOutsideQuotes(text, i + 2, opener === '[[' ? ']]' : '))') : -1;
  if (close !== -1) {
    out += ' ';
    i = close + 2;
  }
  for (let quote = null; i < text.length; i++) {
    const c = text[i];
    if (c === '\\' && quote !== "'") { out += text.slice(i, i + 2); i++; continue; }
    if (quote) { if (c === quote) quote = null; }
    else if (c === '"' || c === "'") quote = c;
    else if (text.startsWith('$((', i)) {
      const end = closeOutsideQuotes(text, i + 3, '))');
      if (end !== -1) {
        out += ' ';
        i = end + 1;
        continue;
      }
    }
    out += c;
  }
  return out;
}

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

// Имя команды без `.exe` (из WSL Windows-бинарь зовётся с ним) и без версии
// интерпретатора: `python.exe`, `python3.12`, `node22` читают так же, как `python` и `node`.
const VERSIONED_RE = /^(python|node|ruby|php|perl|deno|bun)[\d.]+$/;

export function baseCommand(name) {
  const s = String(name).replace(/\.exe$/i, '');
  return VERSIONED_RE.test(s) ? s.replace(/[\d.]+$/, '') : s;
}

// Подкоманда git: первый свободный токен после `git`, минуя глобальные опции
// с аргументом (`git -C dir commit`, `git -c k=v push`). Без этого
// `git log --grep commit` считался бы коммитом. Индекс в токенах или -1.
export function gitSubcommandAt(toks) {
  const i = toks.findIndex((t) => path.basename(t) === 'git');
  if (i === -1) return -1;
  for (let j = i + 1; j < toks.length; j++) {
    const t = toks[j];
    if (['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--config-env', '--super-prefix'].includes(t)) {
      j++;
      continue;
    }
    if (t.startsWith('-')) continue;
    return j;
  }
  return -1;
}

// Коммит со своим содержимым или сообщением: commit, commit-tree (своё дерево), am
// (свой патч), `--continue` после конфликта (разрешение писал агент), merge с
// `-m`/`-F`. Без них merge/cherry-pick/revert/rebase переносят готовые коммиты, pull —
// чужой код: ревью там нечего. У cherry-pick/revert `-m 1` — номер родителя.
// Общий для skill-gate (ревью до коммита) и security-guard (подтверждение коммита).
const RESUMING = new Set(['merge', 'cherry-pick', 'revert', 'rebase']);

export function makesCommit(toks, at) {
  const sub = toks[at];
  const args = toks.slice(at + 1);
  if (sub === 'commit' || sub === 'commit-tree') return true;
  if (sub === 'am') return !args.some((t) => /^--(abort|quit|show-current-patch)/.test(t));
  if (!RESUMING.has(sub)) return false;
  if (args.includes('--continue')) return true;
  return sub === 'merge' && args.some((t) => /^(-m|-F|--message|--file)(=|$)|^-[mF]./.test(t));
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

// Сколько слов занимает перенаправление с этого слова: `2>&1`, `>/dev/null` — одно, голое
// `>`/`2>`/`<<<` — два (цель следует отдельным словом), не перенаправление — 0.
export function redirectWords(t) {
  if (!/^(\d*|&)[<>]/.test(t)) return 0;
  return /^(\d*|&)[<>]+$/.test(t) ? 2 : 1;
}

// cp/mv/ln/rsync/install: источники и назначение (`-t <каталог>` или последний операнд).
export function copyOperands(toks) {
  const ops = [];
  let target = null;
  let opts = true;
  for (let i = commandIndex(toks) + 1; i < toks.length; i++) {
    const t = toks[i];
    if (opts && t === '--') { opts = false; continue; }
    if (opts && (t === '-t' || t === '--target-directory')) { target = toks[++i]; continue; }
    if (opts && t.startsWith('--target-directory=')) { target = t.slice(19); continue; }
    const r = redirectWords(t);
    if (r) { i += r - 1; continue; }
    if (opts && t.length > 1 && t.startsWith('-')) continue;
    ops.push(t);
  }
  return { sources: ops, target: target ?? ops.pop() };
}
