#!/usr/bin/env node
// Подмена `claude` для тестов фонового доктора: печатает отчёт в нужном
// формате, а аргументы и окружение складывает в файл из FAKE_CLAUDE_TRACE.
// FAKE_CLAUDE_EXIT задаёт код возврата (по умолчанию 0), FAKE_CLAUDE_SLEEP_MS —
// задержку перед ответом, чтобы тест успел увидеть состояние running.
import fs from 'node:fs';

const sleepMs = Number(process.env.FAKE_CLAUDE_SLEEP_MS || 0);
if (sleepMs > 0) await new Promise((r) => setTimeout(r, sleepMs));

const trace = process.env.FAKE_CLAUDE_TRACE;
if (trace) {
  fs.writeFileSync(trace, JSON.stringify({
    argv: process.argv.slice(2),
    cwd: process.cwd(),
    envKeys: Object.keys(process.env).filter((k) => k.startsWith('CLAUDE') || k.startsWith('AI_HOOKS_DOCTOR')),
  }));
}

const exit = Number(process.env.FAKE_CLAUDE_EXIT || 0);
if (exit === 0) {
  process.stdout.write('Причина: тестовая причина из подмены claude\nФакт: строка лога\nПредложение: ничего\n');
} else {
  process.stderr.write('fake claude: намеренный сбой\n');
}
process.exit(exit);
