#!/usr/bin/env node
// Тесты хука подключения домена карты: файл домена приходит в контекст, когда
// тронутый путь попал в его `paths:`, один раз на сессию, любым инструментом.
// Гоняется на временном проекте с собственным каталогом состояния.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const HOOK = path.join(ROOT, 'claude', 'links-context.mjs');

let failed = 0;
function check(name, ok, detail = '') {
  process.stdout.write(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok || !detail ? '' : ` — ${detail}`}\n`);
  if (!ok) failed++;
}

const ORDERS = [
  '---',
  'paths:',
  '  - "src/orders/**"',
  '---',
  '',
  '## События',
  '- `order.paid` — эмит `src/orders/service.ts:markPaid` → слушает `src/mail.ts:onPaid`.',
  '',
].join('\n');

function project() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'links-context-test-'));
  const files = {
    'src/orders/service.ts': 'export function markPaid() {}\n',
    'src/mail.ts': 'export function onPaid() {}\n',
    'docs/links/INDEX.md': '# Индекс\n\n- заказы — `orders.md` — оплата\n- почта — `mail.md` — письма\n',
    'docs/links/orders.md': ORDERS,
    'docs/links/mail.md': '## События\n\n- `order.paid` — см. `orders.md`.\n',
  };
  fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
  for (const [rel, body] of Object.entries(files)) {
    const file = path.join(dir, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, body);
  }
  return dir;
}

const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'links-context-state-'));
let session = 0;
const newSession = () => `test-${process.pid}-${++session}`;

function run(dir, toolName, toolInput, { sessionId = newSession(), toolResponse } = {}) {
  const input = JSON.stringify({
    session_id: sessionId,
    cwd: dir,
    tool_name: toolName,
    tool_input: toolInput,
    tool_response: toolResponse,
  });
  const r = spawnSync('node', [HOOK], { input, encoding: 'utf8', env: { ...process.env, AI_HOOKS_STATE_DIR: stateDir } });
  if (!r.stdout) return '';
  return JSON.parse(r.stdout).hookSpecificOutput.additionalContext;
}

const dir = project();

// Первый вызов в сессии — тело домена без frontmatter; второй — тишина.
{
  const sessionId = newSession();
  const first = run(dir, 'Edit', { file_path: path.join(dir, 'src/orders/service.ts') }, { sessionId });
  check('первое касание подключает домен',
    first.includes('docs/links/orders.md') && first.includes('order.paid') && !first.includes('paths:'), first);
  const second = run(dir, 'Read', { file_path: path.join(dir, 'src/orders/service.ts') }, { sessionId });
  check('второе касание в той же сессии молчит', second === '', second);
  const other = run(dir, 'Read', { file_path: path.join(dir, 'src/orders/service.ts') });
  check('другая сессия получает домен снова', other.includes('order.paid'), other);
}

// tokensave принимает путь относительно проекта — резолвим от cwd.
{
  const out = run(dir, 'mcp__tokensave__tokensave_str_replace', { path: 'src/orders/service.ts', old_str: 'a', new_str: 'b' });
  check('относительный путь из tokensave_str_replace', out.includes('order.paid'), out);
  const read = run(dir, 'mcp__tokensave__tokensave_read', { file: 'src/orders/service.ts' });
  check('поле file из tokensave_read', read.includes('order.paid'), read);
}

// tokensave_body не получает путь на входе — файл берётся из ответа.
{
  const toolResponse = { content: [{ type: 'text', text: JSON.stringify({ file: 'src/orders/service.ts', body: '...' }) }] };
  const out = run(dir, 'mcp__tokensave__tokensave_body', { symbol: 'markPaid' }, { toolResponse });
  check('файл из ответа tokensave_body', out.includes('order.paid'), out);
}

// Путь вне глобов — домен не тронут; домен без paths: достижим только по индексу.
{
  const out = run(dir, 'Edit', { file_path: path.join(dir, 'src/mail.ts') });
  check('путь вне paths: молчит', out === '', out);
}

// Нет карты или нет пути во входе — тишина, без ошибок.
{
  const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'links-context-bare-'));
  fs.mkdirSync(path.join(bare, '.git'));
  fs.mkdirSync(path.join(bare, 'src'));
  fs.writeFileSync(path.join(bare, 'src/a.ts'), '');
  check('проект без карты молчит', run(bare, 'Edit', { file_path: path.join(bare, 'src/a.ts') }) === '');
  check('инструмент без пути молчит', run(dir, 'Bash', { command: 'ls' }) === '');
}

process.stdout.write(failed ? `\n=== ${failed} проверок упало ===\n` : '\n=== все проверки прошли ===\n');
process.exit(failed ? 1 : 0);
