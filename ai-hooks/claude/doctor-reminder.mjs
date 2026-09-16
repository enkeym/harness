#!/usr/bin/env node
// Claude Code, UserPromptSubmit: возвращает в основную сессию итог фонового
// доктора — двумя строками, один раз на сессию. Сам доктор пишет отчёт в
// файл и в контекст не попадает; без этого хука пользователь узнавал бы о
// его выводах, только заглянув в ~/.claude/state/doctor/.
//
// Там же — одна строка про затянувшийся server-mismatch: гард в этом случае
// молчит осознанно (fail-open), но молчит и о том, что молчит, и роутеры
// оказывались выключенными по несколько дней незаметно.

import { repoRootOr, currentBranch } from '../state-core.mjs';
import { readState, said, recordSaid, isRunning } from '../doctor-core.mjs';
import { readRecent, insideDoctor } from '../hooklog-core.mjs';
import { readInput } from './hook-io.mjs';

// Внутри самого доктора напоминать некому: он и есть тот разбор, о котором
// шла бы речь, а метка «сказали» уходила бы на его одноразовую сессию.
if (insideDoctor()) process.exit(0);

const REPORT_FRESH_MS = 24 * 60 * 60 * 1000;
const MISMATCH_WINDOW_MS = 10 * 60 * 1000;
// Сколько строк журнала перебирать в поисках свежего рассинхрона.
const RECENT_LINES = 300;

const hhmm = (t) => new Date(t).toTimeString().slice(0, 5);

readInput((input) => {
  const sid = input.session_id;
  if (!sid) process.exit(0);
  const root = repoRootOr(input.cwd);
  const st = readState(root);
  const now = Date.now();
  const lines = [];
  const marks = [];
  let doctorSymptom = null;

  let mismatches = null;
  const recentMismatches = () => (mismatches ??= readRecent(RECENT_LINES).filter((r) =>
    r.decision === 'server-mismatch' && r.root === root &&
    now - Date.parse(r.ts) < MISMATCH_WINDOW_MS));

  // Закрывает отчёт только /doctor apply, а чинят проблему чаще иначе — /mcp,
  // новой сессией, — и отчёт сутки всплывал в каждой сессии проекта. Поэтому
  // объявляем его лишь там, где симптом ещё касается сессии:
  //   breaker-open — отпечаток сессионный, чужой сессии он ни о чём;
  //   server-mismatch — пока журнал видит свежий рассинхрон по той же ветке,
  //     что в отпечатке отчёта: рассинхрон на другой ветке — другая проблема.
  const relevant = () => {
    if (st.symptom === 'breaker-open') return st.sid === sid;
    if (st.symptom === 'server-mismatch') {
      const branch = String(st.fp?.['server-mismatch'] || '').split('|')[1];
      return recentMismatches().some((r) => !branch || r.branch === branch);
    }
    return true;
  };

  const fresh = typeof st.finished === 'number' && now - st.finished < REPORT_FRESH_MS;
  // Применённый отчёт (/doctor apply → bin/doctor-applied.mjs) — уже история.
  const applied = Boolean(st.applied?.[st.symptom]);
  if ((st.status === 'done' || st.status === 'failed') && fresh && !applied && !said(st, 'announced', sid) && relevant()) {
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
    marks.push('announced');
  } else if (isRunning(st, now) && !said(st, 'runningSaid', sid) && relevant()) {
    // Раннер, умерший вместе с WSL, оставляет running навсегда; «итог придёт
    // со следующим промптом» про такой запуск повторялось бы в каждой сессии.
    doctorSymptom = st.symptom;
    lines.push(
      `doctor: по симптому ${st.symptom} с ${hhmm(st.started)} идёт фоновый разбор; ` +
      'итог придёт со следующим промптом, делать ничего не нужно.',
    );
    marks.push('runningSaid');
  }

  if (doctorSymptom !== 'server-mismatch' && !said(st, 'mismatchSaid', sid)) {
    const recent = recentMismatches();
    if (recent.length) {
      lines.push(
        `tokensave-гард молчит: живой MCP-сервер не обслуживает ${root}@${currentBranch(root) || '?'} ` +
        `(${recent.length} событий за 10 мин) — роутеры на эту сессию отключены, файлы читаются целиком. ` +
        'Проверь `claude mcp list`; разбор → /doctor server-mismatch.',
      );
      marks.push('mismatchSaid');
    }
  }

  if (!lines.length) process.exit(0);
  recordSaid(root, marks, sid, st.started);
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'UserPromptSubmit',
      additionalContext: lines.join('\n'),
    },
  }));
  process.exit(0);
});
