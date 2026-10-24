#!/usr/bin/env node
// Тест SessionStart-хука project-bootstrap: пустой node-репозиторий с GitHub
// remote даёт полный список пропусков, вне репозитория хук молчит,
// а недельная метка не мешает первому напоминанию (каталог метки временный).

import './env-isolate.mjs';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SCRIPT = path.join(ROOT, 'claude', 'project-bootstrap.mjs');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bootstrap-test-'));
const repo = path.join(tmp, 'repo');
fs.mkdirSync(repo);
execFileSync('git', ['-C', repo, 'init', '-q']);
execFileSync('git', ['-C', repo, 'remote', 'add', 'origin', 'https://github.com/x/y.git']);
fs.writeFileSync(path.join(repo, 'package.json'), '{}');
fs.writeFileSync(path.join(repo, '.env'), 'A=1\n');

function run(cwd) {
  const out = execFileSync('node', [SCRIPT], {
    input: JSON.stringify({ session_id: 't', cwd, hook_event_name: 'SessionStart', source: 'startup' }),
    encoding: 'utf8',
    env: { ...process.env, HOME: tmp, AI_HOOKS_STATE_DIR: '' },  // недельная метка — под HOME песочницы
  });
  return out.trim() ? JSON.parse(out).hookSpecificOutput.additionalContext : null;
}

let failed = 0;
const check = (name, ok, detail = '') => {
  process.stdout.write(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}\n`);
  if (!ok) failed++;
};

// Недельная метка лежит под HOME теста; сброс — «прошла неделя».
const resetWeekly = () => fs.rmSync(path.join(tmp, '.claude', 'state', 'bootstrap'), { recursive: true, force: true });

const first = run(repo) || '';
check('без индекса: про CLAUDE.md молчит', !/CLAUDE\.md/.test(first), first);
check('без индекса: про карту связей молчит', !/impact-map/.test(first));
check('.env без примера не упоминается', !/\.env/.test(first), first);
check('нет husky', /husky/.test(first));
check('нет CI для GitHub', /workflows/.test(first));
check('нет dependabot', /dependabot/.test(first));

const second = run(repo) || '';
check('повтор: husky/CI молчат неделю', !/husky|workflows/.test(second), second);

fs.writeFileSync(path.join(repo, 'CLAUDE.md'), '# x');
check('всё на месте: хук молчит', run(repo) === null);

check('вне репозитория: молчит', run(tmp) === null);

// Инициализация: индекс появился, CLAUDE.md нет — один раз на проект, дальше молчит.
const fresh = path.join(tmp, 'fresh');
fs.mkdirSync(path.join(fresh, '.tokensave'), { recursive: true });
execFileSync('git', ['-C', fresh, 'init', '-q']);
fs.writeFileSync(path.join(fresh, '.tokensave', 'tokensave.db'), '');
check('индекс без CLAUDE.md: говорит', /CLAUDE\.md/.test(run(fresh) || ''));
check('повтор: CLAUDE.md молчит насовсем', !/CLAUDE\.md/.test(run(fresh) || ''));
resetWeekly();
fs.mkdirSync(path.join(fresh, '.claude'));
fs.writeFileSync(path.join(fresh, '.claude', 'bootstrap-ignore'), 'claude-md\n');
check('bootstrap-ignore: про CLAUDE.md молчит', !/CLAUDE\.md/.test(run(fresh) || ''));
fs.rmSync(fresh, { recursive: true, force: true });

// Индекс есть, карты нет — напоминание о /impact-map, раз в неделю.
const indexed = path.join(tmp, 'indexed');
fs.mkdirSync(path.join(indexed, '.ragsave'), { recursive: true });
execFileSync('git', ['-C', indexed, 'init', '-q']);
fs.writeFileSync(path.join(indexed, 'CLAUDE.md'), '# x');
fs.writeFileSync(path.join(indexed, '.ragsave', 'rag.db'), '');
check('ragsave без карты: напоминает /impact-map', /impact-map/.test(run(indexed) || ''));
check('повтор: карта молчит неделю', run(indexed) === null);

resetWeekly();
fs.mkdirSync(path.join(indexed, 'docs', 'links'), { recursive: true });
fs.writeFileSync(path.join(indexed, 'docs', 'links', 'INDEX.md'), '# x');
check('карта есть: молчит', run(indexed) === null);

fs.rmSync(path.join(indexed, 'docs'), { recursive: true });
fs.rmSync(path.join(indexed, '.ragsave'), { recursive: true });
fs.mkdirSync(path.join(indexed, '.tokensave'));
fs.writeFileSync(path.join(indexed, '.tokensave', 'tokensave.db'), '');
check('tokensave без карты: напоминает /impact-map', /impact-map/.test(run(indexed) || ''));

resetWeekly();
fs.mkdirSync(path.join(indexed, '.claude'));
fs.writeFileSync(path.join(indexed, '.claude', 'bootstrap-ignore'), 'impact-map\n');
check('bootstrap-ignore: про карту молчит', run(indexed) === null);

fs.rmSync(tmp, { recursive: true, force: true });
process.stdout.write(failed ? `\n${failed} FAIL\n` : '\nвсе проверки прошли\n');
process.exit(failed ? 1 : 0);
