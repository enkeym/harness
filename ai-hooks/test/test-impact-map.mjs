#!/usr/bin/env node
// Тесты проверяльщика карты неявных связей. Ловится то, ради чего он написан:
// строка, пережившая удалённый модуль, и карта, разъехавшаяся с индексом.
// Гоняется на временном проекте, чтобы не зависеть от рабочих репозиториев.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SCRIPT = path.join(ROOT, 'bin', 'check-impact-map.mjs');

let failed = 0;
function check(name, ok, detail = '') {
  process.stdout.write(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok || !detail ? '' : ` — ${detail}`}\n`);
  if (!ok) failed++;
}

// Проект-песочница: git-корень, исходник и каталог карты.
function project(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'impact-map-test-'));
  fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
  files = { 'docs/STRATEGY.md': '# Механика\n', ...files };
  for (const [rel, body] of Object.entries(files)) {
    const file = path.join(dir, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, body);
  }
  return dir;
}

function run(dir) {
  try {
    return { code: 0, out: execFileSync('node', [SCRIPT, dir], { encoding: 'utf8' }) };
  } catch (e) {
    return { code: e.status, out: e.stdout || '' };
  }
}

const SERVICE = 'export function markPaid() {}\n';
// Ссылка на документ проекта в индексе — не имя домена: проверяется как путь.
const INDEX = '# Индекс\n\n- заказы — `orders.md` — оплата и статусы. Механика — `docs/STRATEGY.md`.\n';
const ORDERS = '## События\n\n- `order.paid` — эмит `src/orders.service.ts:markPaid` → слушает `src/mail.ts:onPaid`.\n';
const PATHS = '---\npaths:\n  - "src/orders*"\n  - "src/mail.ts"\n---\n\n';

// Живая карта: обе стороны связи на месте.
{
  const dir = project({
    'src/orders.service.ts': SERVICE,
    'src/mail.ts': 'export function onPaid() {}\n',
    'docs/links/INDEX.md': INDEX,
    'docs/links/orders.md': ORDERS,
  });
  const { code, out } = run(dir);
  check('целая карта проходит', code === 0, out.trim());
}

// Модуль удалён, строка осталась — ровно тот случай, ради которого проверка.
{
  const dir = project({
    'src/orders.service.ts': SERVICE,
    'docs/links/INDEX.md': INDEX,
    'docs/links/orders.md': ORDERS,
  });
  const { code, out } = run(dir);
  check('удалённый файл ловится', code === 1 && out.includes('нет файла src/mail.ts'), out.trim());
}

// Файл на месте, символ переименован.
{
  const dir = project({
    'src/orders.service.ts': 'export function markSettled() {}\n',
    'src/mail.ts': 'export function onPaid() {}\n',
    'docs/links/INDEX.md': INDEX,
    'docs/links/orders.md': ORDERS,
  });
  const { code, out } = run(dir);
  check('пропавший символ ловится', code === 1 && out.includes('нет символа markPaid'), out.trim());
}

// Домен не заведён в индексе и наоборот.
{
  const dir = project({
    'src/orders.service.ts': SERVICE,
    'src/mail.ts': 'export function onPaid() {}\n',
    'docs/links/INDEX.md': '# Индекс\n\n- платежи — `payments.md` — оплата\n',
    'docs/links/orders.md': ORDERS,
  });
  const { code, out } = run(dir);
  check('индекс и файлы сверяются в обе стороны',
    code === 1 && out.includes('orders.md не указан') && out.includes('payments.md, а файла нет'), out.trim());
}

// Разбитый домен: подфайл в индексе как `каталог/файл.md`, сосед ссылается на него так же —
// это имя файла карты, а не путь проекта.
{
  const files = {
    'src/orders.service.ts': SERVICE,
    'src/mail.ts': 'export function onPaid() {}\n',
    'docs/links/INDEX.md': '# Индекс\n\n- заказы, оплата — `orders/paid.md` — события оплаты\n- почта — `mail.md` — письма\n',
    'docs/links/orders/paid.md': ORDERS,
    'docs/links/mail.md': '## События\n\n- `order.paid` — см. `orders/paid.md`.\n',
  };
  const { code, out } = run(project(files));
  check('подкаталог домена проходит', code === 0, out.trim());

  const unlisted = run(project({ ...files, 'docs/links/orders/refund.md': '## События\n' }));
  check('подфайл вне индекса ловится',
    unlisted.code === 1 && unlisted.out.includes('orders/refund.md не указан'), unlisted.out.trim());

  const both = run(project({ ...files, 'docs/links/orders.md': ORDERS }));
  check('родительский файл рядом с каталогом ловится',
    both.code === 1 && both.out.includes('родительский файл удалить'), both.out.trim());
}

// Глобы `paths:`: каждый совпадает хотя бы с одним файлом дерева; переехавший
// каталог оставляет глоб без файлов, и хук больше не подключает домен.
{
  const files = {
    'src/orders.service.ts': SERVICE,
    'src/mail.ts': 'export function onPaid() {}\n',
    'docs/links/INDEX.md': INDEX,
    'docs/links/orders.md': `${PATHS}${ORDERS}`,
  };
  const { code, out } = run(project(files));
  check('глобы paths: с файлами проходят', code === 0, out.trim());

  const moved = run(project({
    ...files,
    'docs/links/orders.md': `---\npaths:\n  - "src/orders*"\n  - "src/billing/**"\n---\n${ORDERS}`,
  }));
  check('глоб без файлов ловится',
    moved.code === 1 && moved.out.includes('глоб src/billing/** не совпал'), moved.out.trim());

  const empty = run(project({ ...files, 'docs/links/orders.md': `---\npaths:\n---\n${ORDERS}` }));
  check('пустой paths: ловится', empty.code === 1 && empty.out.includes('paths: пустой'), empty.out.trim());

  const ignored = run(project({
    ...files,
    'node_modules/pkg/index.js': '',
    'docs/links/orders.md': `---\npaths:\n  - "node_modules/**"\n---\n${ORDERS}`,
  }));
  check('глоб на node_modules не считается совпавшим', ignored.code === 1, ignored.out.trim());
}

// Пороги размера: индекс читается каждый проход, домен — по совпавшему глобу.
{
  const dir = project({
    'src/orders.service.ts': SERVICE,
    'src/mail.ts': 'export function onPaid() {}\n',
    'docs/links/INDEX.md': `${INDEX}${'- строка\n'.repeat(40)}`,
    'docs/links/orders.md': `${ORDERS}${'- строка\n'.repeat(90)}`,
  });
  const { code, out } = run(dir);
  check('пороги строк', code === 1 && out.includes('> 30') && out.includes('> 80'), out.trim());
}

// Плоская карта старого вида: замечание про разбивку, ссылки всё равно проверены.
{
  const dir = project({ 'src/orders.service.ts': SERVICE, 'docs/implicit-links.md': ORDERS });
  const { code, out } = run(dir);
  check('плоская карта размечается на разбивку',
    code === 1 && out.includes('плоская карта') && out.includes('нет файла src/mail.ts'), out.trim());
}

// Плейсхолдеры формата — не ссылки.
{
  const dir = project({
    'docs/links/INDEX.md': '# Индекс\n\n- черновики — `drafts.md` — форма\n',
    'docs/links/drafts.md': '## Ключи\n\n- пишет `src/<feature>/Form.tsx:saveDraft`.\n',
  });
  const { code, out } = run(dir);
  check('плейсхолдер не считается ссылкой', code === 0, out.trim());
}

// Путь за пределы проекта не читается: карту в общем репозитории пишем не только мы.
{
  const dir = project({
    'docs/links/INDEX.md': '# Индекс\n\n- сервис — `svc.md` — конфиг\n',
    'docs/links/svc.md': '## Конфиг\n\n- читает `../../other-project/src/keys.ts:apiKey`.\n',
  });
  const { code, out } = run(dir);
  check('выход за корень проекта отбивается', code === 1 && out.includes('за пределы проекта'), out.trim());
}

// Проект без карты — молча ок: карта нужна только там, где есть граф.
{
  const { code } = run(project({ 'src/orders.service.ts': SERVICE }));
  check('проект без карты не ругается', code === 0);
}

process.stdout.write(failed ? `\n=== ${failed} проверок упало ===\n` : '\n=== все проверки прошли ===\n');
process.exit(failed ? 1 : 0);
