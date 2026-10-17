#!/usr/bin/env node
// Тест разрешений из промпта: словарь промпт → категории, сброс следующим
// промптом, привязка к сессии и снятие ask security-guard через dispatch —
// так, как это видит Claude Code (UserPromptSubmit, затем PreToolUse).

import { ISOLATED_HOOKS_LOG } from './env-isolate.mjs';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { grantsIn, recordGrants, isGranted, GRANTS_DIR } from '../grant-core.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const DISPATCH = path.join(ROOT, 'claude', 'dispatch.mjs');

let failed = 0;
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  process.stdout.write(`${ok ? 'ok  ' : 'FAIL'} ${name} (got=${JSON.stringify(got)}, want=${JSON.stringify(want)})\n`);
  if (!ok) failed++;
}

// --- промпт → категории
check('сделай МР → push + mr', grantsIn('сделай МР'), ['mr', 'push']);
check('открой PR', grantsIn('открой PR на эту ветку'), ['mr', 'push']);
check('мерж-реквест', grantsIn('создай мерж-реквест'), ['mr', 'push']);
check('merge request', grantsIn('open a merge request'), ['mr', 'push']);
check('запушь', grantsIn('запушь ветку'), ['push']);
check('push EN', grantsIn('commit and push'), ['push']);
check('форс пуш', grantsIn('сделай форс пуш'), ['push', 'push-force']);
check('перезапиши историю', grantsIn('перезапиши историю на remote'), ['push-force']);
check('удали ветку на remote', grantsIn('удали ветку feat/x на remote'), ['delete', 'push-delete']);
check('удали', grantsIn('удали dist'), ['delete']);
check('rm -rf в тексте', grantsIn('сделай rm -rf node_modules'), ['delete']);
check('откати', grantsIn('откати изменения'), ['revert']);
check('reset --hard в тексте', grantsIn('git reset --hard'), ['revert']);
check('задеплой', grantsIn('задеплой на прод'), ['deploy']);
check('опубликуй', grantsIn('опубликуй пакет'), ['deploy']);
check('накати миграцию', grantsIn('накати миграцию'), ['migrate']);
check('удалённый репозиторий — не удаление', grantsIn('запушь в удалённый репозиторий'), ['push']);
check('обычная просьба — пусто', grantsIn('поправь опечатку в README'), []);
check('пустой промпт', grantsIn(''), []);

// --- отрицания
check('не пушь', grantsIn('не пушь пока'), []);
check('без пуша', grantsIn('закоммить без пуша'), []);
check('пушить не надо', grantsIn('пушить не надо'), []);
check("don't push", grantsIn("don't push yet"), []);
check('не удаляй ветку', grantsIn('не удаляй ветку'), []);
check('отрицание в другой клаузе', grantsIn('не трогай main, запушь feat'), ['push']);
check('отрицание через «и»', grantsIn('не трогай тесты и запушь'), ['push']);

// --- вставки не говорят за пользователя
check('``` блок', grantsIn('посмотри лог\n```\ngit push --force\nrm -rf .\n```'), []);
check('цитата >', grantsIn('что значит\n> задеплой и удали всё'), []);
check('свои слова рядом со вставкой', grantsIn('```\nlog\n```\nзапушь'), ['push']);

// --- состояние: сброс следующим промптом, другой sid
check('запись', recordGrants('s1', 'запушь'), ['push']);
check('s1 видит push', isGranted('s1', 'push'), true);
check('другой sid не видит', isGranted('s2', 'push'), false);
check('другая категория', isGranted('s1', 'delete'), false);
recordGrants('s1', 'спасибо, дальше тесты');
check('следующий промпт сбросил', isGranted('s1', 'push'), false);
check('пустой набор — файла нет', fs.existsSync(path.join(GRANTS_DIR, 's1.json')), false);
check('кривой sid не пишется', recordGrants('../x', 'запушь'), []);

// --- сквозь dispatch: промпт, затем вызов
function prompt(sid, text) {
  execFileSync('node', [DISPATCH, 'UserPromptSubmit'], {
    input: JSON.stringify({ session_id: sid, cwd: ROOT, hook_event_name: 'UserPromptSubmit', prompt: text }),
    encoding: 'utf8',
  });
}
function bash(sid, command) {
  const out = execFileSync('node', [DISPATCH, 'PreToolUse'], {
    input: JSON.stringify({ session_id: sid, cwd: ROOT, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command } }),
    encoding: 'utf8',
  });
  return out.trim() ? JSON.parse(out).hookSpecificOutput.permissionDecision : null;
}
function edit(sid, file_path) {
  const out = execFileSync('node', [DISPATCH, 'PreToolUse'], {
    input: JSON.stringify({ session_id: sid, cwd: ROOT, hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: { file_path, content: '{}' } }),
    encoding: 'utf8',
  });
  return out.trim() ? JSON.parse(out).hookSpecificOutput.permissionDecision : null;
}

const CASES = [
  // [команда, разрешающий промпт]
  ['git push origin feat/x', 'сделай МР'],
  ['git push', 'запушь'],
  ['git push origin main', 'запушь в main'],
  ['gh pr create --fill', 'сделай МР'],
  ['glab mr create --fill', 'создай MR'],
  ['git push --force origin feat', 'форс пуш'],
  ['git push origin :feat', 'удали ветку feat на remote'],
  ['rm -rf .', 'удали всё в каталоге'],
  ['git clean -fd', 'почисти неотслеживаемое'],
  ['git branch -D old', 'удали ветку old'],
  ['docker compose down -v', 'удали тома'],
  ['git reset --hard HEAD~1', 'откати последний коммит'],
  ['git stash drop', 'сбрось стеш'],
  ['npm publish', 'опубликуй пакет'],
  ['npm run deploy', 'задеплой'],
  ['terraform apply', 'задеплой инфраструктуру'],
  ['npx prisma migrate deploy', 'накати миграцию'],
];
for (const [cmd, text] of CASES) {
  const sid = `case-${CASES.findIndex((c) => c[0] === cmd)}`;
  prompt(sid, 'посмотри код');
  check(`${cmd}: без разрешения — ask`, bash(sid, cmd), 'ask');
  prompt(sid, text);
  check(`${cmd}: «${text}» — allow`, bash(sid, cmd), 'allow');
}

// Своё слово для force и удаления ветки.
prompt('force', 'запушь');
check('force push по «запушь» — ask', bash('force', 'git push -f origin feat'), 'ask');
check('+refspec по «запушь» — ask', bash('force', 'git push origin +feat'), 'ask');
check('удаление ветки по «запушь» — ask', bash('force', 'git push origin --delete feat'), 'ask');
check('--all по «запушь» — ask', bash('force', 'git push --all'), 'ask');

// Без категории спрашивается всегда.
prompt('always', 'удали всё, задеплой, запушь, откати');
check('rm -rf ~ по «удали» — ask', bash('always', 'rm -rf ~'), 'ask');
check('rm -rf / по «удали» — ask', bash('always', 'rm -rf /'), 'ask');
check('kubectl get secret -o — ask', bash('always', 'kubectl get secret db -o yaml'), 'ask');
check('env целиком — ask', bash('always', 'env'), 'ask');
check('ssh — ask', bash('always', 'ssh prod systemctl restart app'), 'ask');
check('scp наружу — ask', bash('always', 'scp dump.sql user@host:/tmp/'), 'ask');
check('sudo — ask', bash('always', 'sudo apt install x'), 'ask');
check('cat .env — deny', bash('always', 'cat .env'), 'deny');
check('разрешённый сегмент не прячет следующий', bash('always', 'git push origin feat && rm -rf ~'), 'ask');

// Агент не выдаёт разрешение себе.
check('Write в файлы разрешений — deny', edit('always', path.join(GRANTS_DIR, 'always.json')), 'deny');
check('echo в файлы разрешений — deny', bash('always', 'echo {} > ~/.claude/state/grants/x.json'), 'deny');
check('cd в состояние и запись — deny', bash('always', 'cd ~/.claude/state && echo {} > grants/x.json'), 'deny');

// Разрешение живёт до следующего промпта.
prompt('next', 'сделай МР');
check('после МР push — allow', bash('next', 'git push origin feat'), 'allow');
prompt('next', 'а теперь поправь тест');
check('следующий промпт — снова ask', bash('next', 'git push origin feat'), 'ask');

// Снятое разрешением ask видно в журнале.
const granted = fs.readFileSync(ISOLATED_HOOKS_LOG, 'utf8').trim().split('\n').map((l) => JSON.parse(l))
  .filter((r) => r.decision === 'granted');
check('granted в hooks.jsonl с категорией', granted.some((r) => r.cat === 'push' && r.sid === 'next'), true);

process.stdout.write(failed ? `\n${failed} FAILED\n` : '\nall ok\n');
process.exit(failed ? 1 : 0);
