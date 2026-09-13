#!/usr/bin/env node
// Отметить отчёт фонового доктора применённым. Зовётся из /doctor apply
// последним шагом, из основной сессии. После метки reminder перестаёт
// объявлять этот отчёт, а тот же отпечаток события снова может запустить
// доктора — чтобы после правки проверить, ушёл ли симптом.
//
// Использование: doctor-applied.mjs [cwd] — проект берётся от cwd (git-корень).

import { repoRootOr } from '../state-core.mjs';
import { markApplied, stateFile } from '../doctor-core.mjs';

const root = repoRootOr(process.argv[2] || process.cwd());
const symptom = markApplied(root);
if (!symptom) {
  process.stdout.write(`doctor: для ${root} нет отчёта, отмечать нечего (${stateFile(root)})\n`);
  process.exit(1);
}
process.stdout.write(`doctor: отчёт по ${symptom} для ${root} отмечен применённым\n`);
