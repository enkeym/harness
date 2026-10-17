#!/usr/bin/env node
// Тест разрешений из промпта: словарь промпт → категории, последний
// промпт человека в транскрипте и снятие ask security-guard через dispatch —
// так, как это видит Claude Code (PreToolUse с transcript_path).

import { ISOLATED_HOOKS_LOG } from './env-isolate.mjs';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { grantsIn, lastPrompt, isGranted } from '../grant-core.mjs';

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
check('<pasted_content>', grantsIn('что тут\n<pasted_content id="a">\nзапушь и удали\n</pasted_content id="a">'), []);

// --- транскрипт: только последний промпт человека
const TDIR = fs.mkdtempSync(path.join(os.tmpdir(), 'grants-'));
const human = (content) => ({ type: 'user', origin: { kind: 'human' }, message: { role: 'user', content } });
const plan = (content) => ({ type: 'user', origin: { kind: 'auto-continuation' }, message: { role: 'user', content } });
const toolResult = (content) => ({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content }] } });
const meta = (text) => ({ type: 'user', isMeta: true, origin: { kind: 'human' }, message: { role: 'user', content: [{ type: 'text', text }] } });
const assistant = (text) => ({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } });
let tn = 0;
function transcript(...entries) {
  const file = path.join(TDIR, `t${tn++}.jsonl`);
  fs.writeFileSync(file, entries.map((e) => JSON.stringify(e)).join('\n') + '\n');
  return file;
}

const tPush = transcript(human('запушь'), assistant('пушу'), toolResult('ok'));
check('последний промпт человека', lastPrompt(tPush), 'запушь');
check('push разрешён', isGranted(tPush, 'push'), true);
check('другая категория', isGranted(tPush, 'delete'), false);
check('следующий промпт сбрасывает',
  isGranted(transcript(human('запушь'), assistant('готово'), human('спасибо, дальше тесты')), 'push'), false);
check('план после handoff — не промпт', isGranted(transcript(plan('4. Один push в конце')), 'push'), false);
check('ответ меню — не промпт', isGranted(transcript(human('посмотри'), toolResult('«Запушить»')), 'push'), false);
check('текст скилла (isMeta) — не промпт', isGranted(transcript(human('посмотри'), meta('Push once per request')), 'push'), false);
check('промпт блоками text', lastPrompt(transcript(human([{ type: 'image' }, { type: 'text', text: 'сделай МР' }]))), 'сделай МР');
check('нет транскрипта', isGranted(path.join(TDIR, 'none.jsonl'), 'push'), false);
check('пустой путь', isGranted(undefined, 'push'), false);

// --- сквозь dispatch: транскрипт с промптом, затем вызов
function bash(sid, text, command) {
  const out = execFileSync('node', [DISPATCH, 'PreToolUse'], {
    input: JSON.stringify({ session_id: sid, transcript_path: transcript(human(text)), cwd: ROOT, hook_event_name: 'PreToolUse',
      tool_name: 'Bash', tool_input: { command } }),
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
  check(`${cmd}: без разрешения — ask`, bash(sid, 'посмотри код', cmd), 'ask');
  check(`${cmd}: «${text}» — allow`, bash(sid, text, cmd), 'allow');
}

// Своё слово для force и удаления ветки.
check('force push по «запушь» — ask', bash('force', 'запушь', 'git push -f origin feat'), 'ask');
check('+refspec по «запушь» — ask', bash('force', 'запушь', 'git push origin +feat'), 'ask');
check('удаление ветки по «запушь» — ask', bash('force', 'запушь', 'git push origin --delete feat'), 'ask');
check('--all по «запушь» — ask', bash('force', 'запушь', 'git push --all'), 'ask');

// Без категории спрашивается всегда.
const ALL_WORDS = 'удали всё, задеплой, запушь, откати';
check('rm -rf ~ по «удали» — ask', bash('always', ALL_WORDS, 'rm -rf ~'), 'ask');
check('rm -rf / по «удали» — ask', bash('always', ALL_WORDS, 'rm -rf /'), 'ask');
check('kubectl get secret -o — ask', bash('always', ALL_WORDS, 'kubectl get secret db -o yaml'), 'ask');
check('env целиком — ask', bash('always', ALL_WORDS, 'env'), 'ask');
check('ssh — ask', bash('always', ALL_WORDS, 'ssh prod systemctl restart app'), 'ask');
check('scp наружу — ask', bash('always', ALL_WORDS, 'scp dump.sql user@host:/tmp/'), 'ask');
check('sudo — ask', bash('always', ALL_WORDS, 'sudo apt install x'), 'ask');
check('cat .env — deny', bash('always', ALL_WORDS, 'cat .env'), 'deny');
check('разрешённый сегмент не прячет следующий', bash('always', ALL_WORDS, 'git push origin feat && rm -rf ~'), 'ask');

// Разрешение живёт до следующего промпта.
check('после МР push — allow', bash('next', 'сделай МР', 'git push origin feat'), 'allow');
check('следующий промпт — снова ask', bash('next', 'а теперь поправь тест', 'git push origin feat'), 'ask');

// Снятое разрешением ask видно в журнале.
const granted = fs.readFileSync(ISOLATED_HOOKS_LOG, 'utf8').trim().split('\n').map((l) => JSON.parse(l))
  .filter((r) => r.decision === 'granted');
check('granted в hooks.jsonl с категорией', granted.some((r) => r.cat === 'push' && r.sid === 'next'), true);

process.stdout.write(failed ? `\n${failed} FAILED\n` : '\nall ok\n');
process.exit(failed ? 1 : 0);
