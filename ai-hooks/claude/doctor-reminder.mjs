#!/usr/bin/env node
// Claude Code, UserPromptSubmit: возвращает в основную сессию итог фонового
// доктора — двумя строками, один раз на сессию. Сам доктор пишет отчёт в
// файл и в контекст не попадает; без этого хука пользователь узнавал бы о
// его выводах, только заглянув в ~/.claude/state/doctor/.
//
// Там же — одна строка про затянувшийся server-mismatch: гард в этом случае
// молчит осознанно (fail-open), но молчит и о том, что молчит, и роутеры
// оказывались выключенными по несколько дней незаметно.

import { repoRootOr, currentBranch, writeJSON } from '../state-core.mjs';
import { readState, stateFile } from '../doctor-core.mjs';
import { readRecent } from '../hooklog-core.mjs';
import { readInput } from './hook-io.mjs';

const REPORT_FRESH_MS = 24 * 60 * 60 * 1000;
const MISMATCH_WINDOW_MS = 10 * 60 * 1000;
// Сколько строк журнала перебирать в поисках свежего рассинхрона и сколько
// сессий помнить как «уже сказали» — файл состояния не должен расти вечно.
const RECENT_LINES = 300;
const SAID_KEEP = 20;

const hhmm = (t) => new Date(t).toTimeString().slice(0, 5);

function said(st, key, sid) {
  return Array.isArray(st[key]) && st[key].includes(sid);
}
function mark(st, key, sid) {
  st[key] = [...(Array.isArray(st[key]) ? st[key] : []), sid].slice(-SAID_KEEP);
}

readInput((input) => {
  const sid = input.session_id;
  if (!sid) process.exit(0);
  const root = repoRootOr(input.cwd);
  const st = readState(root);
  const now = Date.now();
  const lines = [];
  let doctorSymptom = null;

  const fresh = typeof st.finished === 'number' && now - st.finished < REPORT_FRESH_MS;
  if ((st.status === 'done' || st.status === 'failed') && fresh && !said(st, 'announced', sid)) {
    doctorSymptom = st.symptom;
    if (st.status === 'done') {
      lines.push(
        `doctor (${hhmm(st.finished)}, ${st.symptom}): ${st.headline || 'отчёт без строки «Причина»'} ` +
        `Отчёт: ${st.report} — относится к текущей работе → прочитай его Read; применить правку → /doctor apply.`,
      );
    } else {
      lines.push(
        `doctor (${hhmm(st.finished)}, ${st.symptom}): фоновый запуск не завершился (exit ${st.exit}); ` +
        `детали в ${st.report}.log.`,
      );
    }
    mark(st, 'announced', sid);
  } else if ((st.status === 'queued' || st.status === 'running') && !said(st, 'runningSaid', sid)) {
    doctorSymptom = st.symptom;
    lines.push(
      `doctor: по симптому ${st.symptom} с ${hhmm(st.started)} идёт фоновый разбор; ` +
      'итог придёт со следующим промптом, делать ничего не нужно.',
    );
    mark(st, 'runningSaid', sid);
  }

  if (doctorSymptom !== 'server-mismatch' && !said(st, 'mismatchSaid', sid)) {
    const recent = readRecent(RECENT_LINES).filter((r) =>
      r.decision === 'server-mismatch' && r.root === root &&
      now - Date.parse(r.ts) < MISMATCH_WINDOW_MS);
    if (recent.length) {
      lines.push(
        `tokensave-гард молчит: живой MCP-сервер не обслуживает ${root}@${currentBranch(root) || '?'} ` +
        `(${recent.length} событий за 10 мин) — роутеры на эту сессию отключены, файлы читаются целиком. ` +
        'Проверь `claude mcp list`; разбор → /doctor server-mismatch.',
      );
      mark(st, 'mismatchSaid', sid);
    }
  }

  if (!lines.length) process.exit(0);
  writeJSON(stateFile(root), { ...st, root: st.root || root });
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'UserPromptSubmit',
      additionalContext: lines.join('\n'),
    },
  }));
  process.exit(0);
});
