#!/usr/bin/env node
// Проверка хука-напоминания про rag_search: на каких промптах он подаёт голос,
// а на каких обязан молчать. Ходит в реальный проект с .ragsave/rag.db —
// если проект переехал, поправь RAG_PROJECT.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const HOOK = new URL('../claude/ragsave-reminder.mjs', import.meta.url).pathname;
const RAG_PROJECT = '/home/enkeym/main/vpn-new';
const NO_RAG = '/tmp';
const HOME = process.env.HOME || os.homedir();

let pass = 0;
let fail = 0;
let session = 0;

// Дроссель привязан к сессии, поэтому каждый сценарий получает свою.
function run(prompt, cwd) {
  const input = JSON.stringify({
    prompt,
    cwd,
    session_id: `test-${process.pid}-${++session}`,
  });
  const r = spawnSync('node', [HOOK], { input, encoding: 'utf8' });
  return r.stdout || '';
}

function check(name, want, prompt, cwd = RAG_PROJECT) {
  const out = run(prompt, cwd);
  const got = out.includes('rag_search') ? 'remind' : 'silent';
  if (got === want) {
    pass++;
    console.log(`  ok   ${name}`);
  } else {
    fail++;
    console.log(`  FAIL ${name}: ожидалось ${want}, получено ${got}`);
  }
}

console.log('\nсмысловые запросы → напоминание');
check('как настроен деплой', 'remind', 'как настроен деплой на прод?');
check('где переменные почты', 'remind', 'где лежат переменные для почты');
check('почему отваливается воркер', 'remind', 'почему воркер отваливается через минуту');
check('разберись', 'remind', 'разберись, что происходит при оплате');
check('английский how', 'remind', 'how is the deploy configured here');
check('вопрос без знака', 'remind', 'объясни как устроена авторизация');

console.log('\nимя названо → tokensave, молчим');
check('путь с расширением', 'silent', 'где в auth.service.ts выставлен таймаут');
check('идентификатор в бэктиках', 'silent', 'как работает `createSubscription`');
check('camelCase', 'silent', 'почему getUserById возвращает null');
check('snake_case', 'silent', 'где используется user_sessions');
check('вызов функции', 'silent', 'как вызывается handlePayment()');

console.log('\nструктурные вопросы → tokensave, молчим');
check('кто вызывает', 'silent', 'кто вызывает эту штуку');
check('что сломается', 'silent', 'что сломается, если поменять это поле');
check('impact', 'silent', 'посмотри impact для этой правки');

console.log('\nнет повода → молчим');
check('нет смыслового слова', 'silent', 'добавь логирование в модуль оплаты');
check('слэш-команда', 'silent', '/code-review как всегда');
check('пустой промпт', 'silent', '   ');
check('нет .ragsave в проекте', 'silent', 'как настроен деплой', NO_RAG);

console.log('\nдроссель');
{
  const sid = `test-throttle-${process.pid}`;
  const one = JSON.stringify({ prompt: 'как настроен деплой', cwd: RAG_PROJECT, session_id: sid });
  const first = spawnSync('node', [HOOK], { input: one, encoding: 'utf8' }).stdout || '';
  const second = spawnSync('node', [HOOK], { input: one, encoding: 'utf8' }).stdout || '';
  if (first.includes('rag_search') && !second.includes('rag_search')) {
    pass++;
    console.log('  ok   повтор в той же сессии подавлен');
  } else {
    fail++;
    console.log('  FAIL повтор в той же сессии не подавлен');
  }
  // метку за собой убираем, чтобы прогон не влиял на следующий
  const dir = path.join(HOME, '.claude', 'state', 'ragsave-reminder');
  try {
    for (const f of fs.readdirSync(dir)) {
      if (f.startsWith('test-')) fs.unlinkSync(path.join(dir, f));
    }
  } catch { /* каталога нет — нечего чистить */ }
}

console.log(`\nитог: ${pass} ok, ${fail} fail\n`);
process.exit(fail ? 1 : 0);
