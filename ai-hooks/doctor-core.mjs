// Фоновый доктор. /doctor сам по себе ловит только то, о чём его спросили:
// пока пользователь не скопирует симптом в новую сессию, зациклившийся хук
// или молчащий гард живут незамеченными. Здесь тот же скилл запускается
// автоматически — отдельным headless-процессом `claude -p`, со своим
// контекстом, — в момент, когда хук фиксирует «модель спотыкается»:
// открылся предохранитель повторов или гард отступил из-за рассинхрона с MCP.
//
// Что доктор НЕ делает: не правит ничего. Только чтение и отчёт в файл; в
// основную сессию попадают две строки на следующем промпте (doctor-reminder).
// Автоправка харнеса из фонового процесса, которого никто не видит, хуже
// открытого вопроса — применяет человек или основная сессия через /doctor.
//
// Стоимость держат четыре ограничителя: один запуск на (проект, симптом) в
// DEBOUNCE_MS, один запуск на отпечаток события (см. fingerprintOf), бюджет
// --max-budget-usd на запуск, и метка AI_HOOKS_DOCTOR=1 в окружении ребёнка —
// хуки внутри доктора доктора не порождают.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { statePath, readJSON, writeJSON, projectKey, currentBranch } from './state-core.mjs';
import { HOOKS_LOG, DOCTOR_MARK, insideDoctor } from './hooklog-core.mjs';

const HOME = process.env.HOME || os.homedir();
const HERE = path.dirname(fileURLToPath(import.meta.url));
const HARNESS_REPO = path.join(HOME, 'harness');
const LOGS_DIR = path.join(HOME, '.ai-hooks', 'logs');

export const DOCTOR_DIR = statePath('doctor');
export const CHILD_MARK = DOCTOR_MARK;
export const RUNNER = path.join(HERE, 'bin', 'doctor-run.mjs');
export const SKILL_FILE = path.join(HOME, '.claude', 'skills', 'doctor', 'SKILL.md');

// Нижний порог между запусками по одному симптому. Сам по себе он от холостых
// запусков не спасал: server-mismatch при смене ветки держится всю сессию
// (сервер не перечитывает БД), и каждые полчаса доктор за доллар ставил бы
// тот же диагноз. Поэтому основной ограничитель — отпечаток события.
export const DEBOUNCE_MS = 30 * 60 * 1000;
// Запуск, который не отчитался за это время, считается мёртвым: следующий
// симптом запускает нового доктора, не дожидаясь.
export const STALE_RUN_MS = 15 * 60 * 1000;
// Одна сессия: CLAUDE.md + скилл + несколько чтений логов. Проверено: ход с
// загрузкой контекста уже дороже 0.05, диагноз в 5–10 ходов укладывается в 1$.
// Превышение — claude выходит с «Exceeded USD budget», отчёт остаётся пустым,
// статус failed; напоминание ведёт в .log.
export const BUDGET_USD = '1.00';
export const MODEL = 'sonnet';

// Только чтение. git — лишь просмотр: коммит в ~/harness остаётся за основной
// сессией, где его видит пользователь и где security-guard спросит.
export const ALLOWED_TOOLS = [
  'Read', 'Grep', 'Glob',
  'Bash(tail:*)', 'Bash(ls:*)', 'Bash(wc:*)', 'Bash(ps:*)',
  'Bash(claude mcp list)', 'Bash(claude plugin list)',
  `Bash(git -C ${HARNESS_REPO} log:*)`,
  `Bash(git -C ${HARNESS_REPO} status:*)`,
  `Bash(git -C ${HARNESS_REPO} diff:*)`,
  `Bash(node ${path.join(HOME, '.ai-hooks', 'bin', 'ask-mode.mjs')} status:*)`,
];
export const DISALLOWED_TOOLS = ['Edit', 'Write', 'NotebookEdit', 'Agent', 'Skill'];

export const SYMPTOMS = {
  'breaker-open':
    'предохранитель повторов открылся — гард второй раз запретил одно и то же, ' +
    'модель не нашла рабочей альтернативы (обычно tokensave не отвечает или граф не той ветки)',
  'server-mismatch':
    'гард tokensave промолчал: живой MCP-сервер не обслуживает этот проект и ветку, ' +
    'роутеры на эту сессию фактически отключены',
};

// Выключатели: метка ребёнка (защита от рекурсии), переменная окружения и
// файл off в каталоге состояния — для «отключить, не трогая конфиг».
export function doctorEnabled() {
  if (insideDoctor()) return false;
  if (process.env.AI_HOOKS_DOCTOR_OFF === '1') return false;
  return !fs.existsSync(path.join(DOCTOR_DIR, 'off'));
}

export function stateFile(root) {
  return path.join(DOCTOR_DIR, `${projectKey(root)}.json`);
}

export function readState(root) {
  return readJSON(stateFile(root), {});
}

function isRunning(st, now) {
  if (st.status !== 'running' && st.status !== 'queued') return false;
  return typeof st.started === 'number' && now - st.started < STALE_RUN_MS;
}

// Что считать «той же проблемой». Пока отпечаток не сменился и отчёт по нему
// не применён, второго доктора не будет — сколько бы часов ни прошло.
//   server-mismatch: проект + ветка + БД, по которой судит гард. Сменилась
//     ветка или БД — это новое состояние, его стоит разобрать заново.
//   breaker-open: сессия + класс инструментов. Один цикл в одной сессии — одна
//     проблема; новая сессия (в т.ч. после /clear) получает своего доктора.
export function fingerprintOf(symptom, detail = {}, sid = null) {
  if (symptom === 'server-mismatch') {
    return [detail.root || '', detail.branch || '', detail.guard_db || ''].join('|');
  }
  if (symptom === 'breaker-open') {
    return [sid || '', detail.family || detail.tool || ''].join('|');
  }
  return sid || '';
}

// Отчёт применён (/doctor apply): тот же отпечаток снова может позвать
// доктора — после правки хуков стоит проверить, ушёл ли симптом. Зовёт
// bin/doctor-applied.mjs из основной сессии; возвращает симптом или null,
// если применять было нечего.
export function markApplied(root) {
  const file = stateFile(root);
  const st = readJSON(file, {});
  // Идущий запуск отмечать нечем: отчёта ещё нет, а метка скрыла бы его итог.
  if (!st.symptom || !st.report || (st.status !== 'done' && st.status !== 'failed')) return null;
  writeJSON(file, { ...st, applied: { ...(st.applied || {}), [st.symptom]: true } });
  return st.symptom;
}

function isApplied(st, symptom) {
  return Boolean(st.applied?.[symptom]);
}

// Текст задания ребёнку. Скилл он читает сам (Read разрешён) — дублировать
// процедуру здесь значило бы держать две версии /doctor.
export function buildPrompt({ root, symptom, detail, sid }) {
  const branch = currentBranch(root) || '(detached / нет ветки)';
  return [
    `Ты фоновый /doctor харнеса. Прочитай ${SKILL_FILE} и выполни его процедуру для симптома ниже.`,
    'Ничего не правь и не предлагай себе править — только диагноз и предложение; применит основная сессия.',
    '',
    `Симптом: ${symptom} — ${SYMPTOMS[symptom] || symptom}.`,
    `Проект: ${root} (ветка ${branch}). Сессия, в которой это случилось: ${sid || 'неизвестна'}.`,
    `Событие: ${JSON.stringify(detail)}`,
    '',
    'Где смотреть в первую очередь:',
    `- ${HOOKS_LOG} — журнал решений хуков (JSONL); отфильтруй записи с "sid":"${sid || ''}" — это последовательность запретов той сессии, время работы хука в ms.`,
    `- ${path.join(LOGS_DIR, 'guard.log')}, ${path.join(LOGS_DIR, 'errors.log')}.`,
    `- реестр MCP-серверов ${path.join(HOME, '.tokensave', 'servers')}, каталог ${path.join(root, '.tokensave')}.`,
    '',
    'Формат ответа — строго, он попадёт в файл и будет прочитан по строкам:',
    'Причина: <одно предложение>',
    'Факт: <одна строка из лога, которая её подтверждает>',
    'Предложение: <что поменять и где — файл и суть правки; или «причина не найдена, проверено: …»>',
    'Далее при необходимости — короткое пояснение.',
  ].join('\n');
}

function childEnv() {
  // Ребёнок — самостоятельная сессия, а не вложенная: переменные родительской
  // сессии Claude Code (сокет, session id, флаг CLAUDECODE) ему только мешают.
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (!k.startsWith('CLAUDE')) env[k] = v;
  }
  env[CHILD_MARK] = '1';
  return env;
}

// Возвращает true, если доктор запущен; false — выключен, уже идёт, этот
// симптом на этом проекте разбирали в окне дебаунса, или это та же проблема
// (отпечаток не сменился, отчёт не применён). Упавший запуск отпечаток не
// «занимает»: после дебаунса та же проблема разбирается заново.
export function maybeSpawnDoctor({ root, symptom, detail = {}, sid = null }) {
  if (!root || !doctorEnabled()) return false;
  const now = Date.now();
  const file = stateFile(root);
  const st = readJSON(file, {});
  if (isRunning(st, now)) return false;
  const last = st.last?.[symptom];
  if (typeof last === 'number' && now - last < DEBOUNCE_MS) return false;
  const fp = fingerprintOf(symptom, detail, sid);
  const lastFailed = st.symptom === symptom && st.status === 'failed';
  if (st.fp?.[symptom] === fp && !isApplied(st, symptom) && !lastFailed) return false;

  try {
    fs.mkdirSync(DOCTOR_DIR, { recursive: true });
    const stamp = new Date(now).toISOString().replace(/[:.]/g, '-');
    const base = path.join(DOCTOR_DIR, `${projectKey(root)}-${stamp}`);
    const promptFile = `${base}.prompt.md`;
    const report = `${base}.md`;
    fs.writeFileSync(promptFile, buildPrompt({ root, symptom, detail, sid }));

    // Метку ставим ДО запуска: параллельный хук, увидев queued, не запустит
    // второго доктора на тот же проект.
    writeJSON(file, {
      ...st,
      root,
      status: 'queued',
      symptom,
      sid,
      started: now,
      finished: null,
      report,
      headline: null,
      exit: null,
      last: { ...(st.last || {}), [symptom]: now },
      fp: { ...(st.fp || {}), [symptom]: fp },
      applied: { ...(st.applied || {}), [symptom]: false },
      // Новый отчёт — новая новость: сессия, которой сказали о прошлом, иначе
      // не узнала бы о следующем.
      announced: [],
      runningSaid: [],
    });

    const child = spawn(process.execPath, [RUNNER, file, report, promptFile, root], {
      cwd: root,
      detached: true,
      stdio: 'ignore',
      env: childEnv(),
    });
    child.unref();
    return true;
  } catch {
    return false; // доктор — удобство; его отказ не должен трогать хук
  }
}

// Аргументы headless-сессии. Промпт идёт первым позиционным: variadic-опции
// (--allowedTools a b c) проглотили бы его, стой он после них.
export function claudeArgs(prompt) {
  return [
    '-p', prompt,
    '--model', MODEL,
    '--effort', 'medium',
    '--permission-mode', 'dontAsk',
    '--no-session-persistence',
    '--output-format', 'text',
    '--max-budget-usd', BUDGET_USD,
    '--disallowedTools', ...DISALLOWED_TOOLS,
    '--allowedTools', ...ALLOWED_TOOLS,
  ];
}

// Первая содержательная строка отчёта — та, что уйдёт в напоминание.
export function headlineOf(report) {
  try {
    const lines = fs.readFileSync(report, 'utf8').split('\n').map((l) => l.trim()).filter(Boolean);
    return lines.find((l) => l.startsWith('Причина:')) || lines[0] || null;
  } catch {
    return null;
  }
}
