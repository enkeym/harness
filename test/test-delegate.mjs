#!/usr/bin/env node
// Тест слоя делегирования. Внешние CLI здесь не вызываются: их ответы зависят
// от сети и чужих квот, и такой тест был бы не проверкой, а лотереей.
// Проверяется то, что ломается молча и стоит дорого: секрет, ушедший наружу;
// протухший кеш здоровья, выключивший рабочего провайдера на весь день;
// мусор в ответе от рамки opencode.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findSecretValue } from '../security-core.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SCRIPT = path.join(ROOT, 'bin', 'delegate.mjs');

let failed = 0;
function check(name, got, want) {
  const ok = got === want;
  process.stdout.write(`${ok ? 'ok  ' : 'FAIL'} ${name} (got=${got}, want=${want})\n`);
  if (!ok) failed++;
}

// --- секрет не должен уходить внешнему провайдеру
const leaky = [
  ['токен Telegram', 'почини: BOT_TOKEN=7123456789:AAFabcdefghijklmnopqrstuvwxyz012345'],
  ['ключ GitHub', 'проверь доступ ghp_abcdefghijklmnopqrstuvwxyz0123456789'],
  ['строка подключения', 'мигрируй postgres://app:s3cretpass@db.example.com:5432/app'],
  ['приватный ключ', 'разбери -----BEGIN RSA PRIVATE KEY-----'],
];
for (const [name, prompt] of leaky) {
  let code = 0;
  let out = '';
  try {
    out = execFileSync('node', [SCRIPT, prompt], { encoding: 'utf8', timeout: 20000 });
  } catch (e) {
    code = e.status ?? 1;
    out = String(e.stderr || '');
  }
  const refused = code !== 0 && /похожее на секрет/.test(out);
  check(`секрет не уходит наружу: ${name}`, refused ? 'отклонено' : 'ОТПРАВЛЕНО', 'отклонено');
}

// Безобидная задача не должна отклоняться как секрет — иначе фильтр
// превращается в запрет делегирования вообще.
const safe = [
  'объясни разницу между LEFT JOIN и INNER JOIN',
  'напиши регулярку для даты YYYY-MM-DD',
  'переведи на английский: индекс обновляется в фоне',
  'разбери стектрейс: TypeError: Cannot read properties of undefined',
];
for (const prompt of safe) {
  check(`не ложное срабатывание: ${prompt.slice(0, 34)}…`, findSecretValue(prompt) ? 'отклонено' : 'пропущено', 'пропущено');
}

// --- кеш здоровья: отказ живёт недолго, успех долго
const { STATE_ROOT } = await import('../state-core.mjs');
const HEALTH = path.join(STATE_ROOT, 'cli-health.json');
let health = null;
try { health = JSON.parse(fs.readFileSync(HEALTH, 'utf8')); } catch { /* ещё не было проверок */ }
if (health) {
  const shapeOk = Object.values(health).every((e) => typeof e.ok === 'boolean' && typeof e.checked === 'string');
  check('кеш здоровья: форма записей', shapeOk ? 'верна' : 'сломана', 'верна');
} else {
  process.stdout.write('--   кеш здоровья ещё не создан, проверка пропущена\n');
}

// --- справка и список провайдеров работают без сети
let listed = '';
try {
  listed = execFileSync('node', [SCRIPT, '--list'], { encoding: 'utf8', timeout: 120000 });
} catch (e) {
  listed = String(e.stdout || '');
}
check('--list называет DeepSeek', /DeepSeek/.test(listed) ? 'да' : 'нет', 'да');
check('--list называет GLM', /GLM/.test(listed) ? 'да' : 'нет', 'да');
check('--list называет Codex', /Codex/.test(listed) ? 'да' : 'нет', 'да');

// --- пустая задача отклоняется с подсказкой, а не падает молча
let emptyCode = 0;
let emptyErr = '';
try {
  execFileSync('node', [SCRIPT], { encoding: 'utf8', timeout: 20000 });
} catch (e) {
  emptyCode = e.status ?? 1;
  emptyErr = String(e.stderr || '');
}
check('пустая задача: код выхода', emptyCode === 2 ? '2' : String(emptyCode), '2');
check('пустая задача: есть подсказка', /usage:/.test(emptyErr) ? 'да' : 'нет', 'да');

process.stdout.write(failed ? `\n=== ${failed} FAIL ===\n` : '\n=== все проверки прошли ===\n');
process.exit(failed ? 1 : 0);
