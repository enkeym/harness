#!/usr/bin/env node
// Тесты prompt-shape (prompt-core.mjs, claude/prompt-shape.mjs): длинный
// промпт из нескольких фраз без якоря получает напоминание о task-brief, а
// любой якорь — путь, имя, код, ошибка, ссылка, вставка, команда — его гасит.
// Ложное срабатывание дешёвое, но на каждом промпте с путём оно стало бы шумом.

import './env-isolate.mjs';
import { isLoosePrompt, LOOSE_PROMPT_HINT, LOOSE_MIN_CHARS } from '../prompt-core.mjs';
import { markLoaded } from '../skill-core.mjs';
import { check as promptShape } from '../claude/prompt-shape.mjs';

let failed = 0;
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  process.stdout.write(`${ok ? 'ok  ' : 'FAIL'} ${name} (got=${JSON.stringify(got)}, want=${JSON.stringify(want)})\n`);
  if (!ok) failed++;
}

const SENTENCES = [
  'Хочу, чтобы приложение работало лучше и пользователям было удобнее.',
  'Сейчас многое выглядит странно, и непонятно, что с этим делать дальше.',
  'Надо подумать над тем, как улучшить общий опыт и сделать всё быстрее.',
  'Ещё хотелось бы, чтобы настройки было проще находить, а уведомления не мешали работе.',
  'Может быть, стоит переделать главный экран целиком, но я не уверен, что это правильный путь.',
  'Посмотри и предложи, что можно сделать в первую очередь.',
];
const LOOSE = SENTENCES.join(' ');
const clause = (s) => s.replace(/\.$/, '');
// Те же слова без границ фраз: одна длинная фраза и две.
const ONE = SENTENCES.map(clause).join(', ');
const TWO = `${SENTENCES.slice(0, 3).map(clause).join(', ')}. ${SENTENCES.slice(3).map(clause).join(', ')}.`;

const hint = (prompt, sid) => promptShape({ prompt, session_id: sid });

check('фикстура длиннее порога', [LOOSE.length >= LOOSE_MIN_CHARS, ONE.length >= LOOSE_MIN_CHARS], [true, true]);

// --- размытый промпт: подсказка ---
check('размытый: подсказка', hint(LOOSE, 'sid-a'), { context: LOOSE_PROMPT_HINT });
check('размытый по строкам: подсказка', isLoosePrompt(SENTENCES.map(clause).join('\n')), true);
check('подсказка называет task-brief', LOOSE_PROMPT_HINT.includes('task-brief'), true);

// --- форма: коротко, одна-две фразы, команда ---
check('короткий: null', hint(SENTENCES.slice(0, 3).join(' '), 'sid-a'), null);
check('одна длинная фраза: null', hint(ONE, 'sid-a'), null);
check('две длинные фразы: null', hint(TWO, 'sid-a'), null);
check('/команда: null', hint(`/task-brief ${LOOSE}`, 'sid-a'), null);
check('не строка: null', promptShape({ session_id: 'sid-a' }), null);

// --- якоря ---
const anchors = {
  'путь': ' Смотри src/app.ts.',
  'файл без каталога': ' Начни с package.json.',
  'абсолютный путь': ' Всё лежит в /etc/nginx.',
  'имя в обратных кавычках': ' Речь про `корзину`.',
  'блок кода': '\n```\nconst a = 1;\n```',
  'camelCase': ' Падает в fetchUserProfile.',
  'snake_case': ' Таблица user_settings тоже.',
  'ошибка': '\nTypeError: cannot read properties of undefined',
  'стек': '\n    at handler:42:7',
  'URL': ' Макет на https://example.com/design.',
  'вставка': '\n<pasted_content id="1">лог</pasted_content>',
};
for (const [name, tail] of Object.entries(anchors)) {
  check(`якорь ${name}: null`, hint(LOOSE + tail, 'sid-a'), null);
}

// --- длинный токен без пробелов (до предела paste-guard) — без квадратичного перебора ---
for (const unit of ['a', 'a-', 'aE']) {
  const start = Date.now();
  isLoosePrompt(`${LOOSE} ${unit.repeat(39000 / unit.length)}`);
  check(`токен «${unit}»×: быстрее 500 мс`, Date.now() - start < 500, true);
}

// --- task-brief загружен в этой сессии: молчание, в другой — подсказка ---
markLoaded('sid-tb', 'task-brief');
check('task-brief загружен: null', hint(LOOSE, 'sid-tb'), null);
check('task-brief в другой сессии: подсказка', hint(LOOSE, 'sid-other'), { context: LOOSE_PROMPT_HINT });
check('без session_id: подсказка', hint(LOOSE), { context: LOOSE_PROMPT_HINT });

process.stdout.write(failed ? `\n=== ${failed} проверок упало ===\n` : '\n=== все проверки прошли ===\n');
process.exit(failed ? 1 : 0);
