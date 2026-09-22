#!/usr/bin/env node
// Состязательные тесты гарда безопасности: не «работает ли он на обычных
// командах» (это test-security.mjs), а «какими формами его обходят».
//
// Философия гарда — закрыть удобный путь, а не поймать любой обход: намеренное
// маскирование (`cat .en''v`) не ловится и ловиться не должно, иначе гард
// превращается в парсер shell. Здесь проверяются формы, которые агент выбирает
// не для обхода, а просто потому что они естественны: обёртки интерпретатора,
// чтение из git, `find -exec`, команда на удалённом хосте.

import './env-isolate.mjs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SCRIPT = path.join(ROOT, 'claude', 'security-guard.mjs');

function verdict(command) {
  const out = execFileSync('node', [SCRIPT], {
    input: JSON.stringify({
      session_id: 'bypass', cwd: '/home/enkeym/main/vpn-new',
      tool_name: 'Bash', tool_input: { command },
    }),
    encoding: 'utf8',
  });
  return out.trim() ? JSON.parse(out).hookSpecificOutput.permissionDecision : 'allow';
}

let failed = 0;
function check(name, command, want) {
  const got = verdict(command);
  const ok = got === want;
  process.stdout.write(`${ok ? 'ok  ' : 'FAIL'} ${name}\n     ${command}\n     got=${got}, want=${want}\n`);
  if (!ok) failed++;
}

process.stdout.write('--- обёртки интерпретатора ---\n');
check('bash -c', `bash -c "cat .env"`, 'deny');
check('sh -c', `sh -c 'cat .env'`, 'deny');
check('zsh -c', `zsh -c "head .env"`, 'deny');
check('bash -lc', `bash -lc "grep TOKEN .env"`, 'deny');

process.stdout.write('\n--- чтение через git ---\n');
check('git show из индекса', `git show HEAD:.env`, 'deny');
check('git show из ветки', `git show main:config/.env.production`, 'deny');
check('git cat-file', `git cat-file -p HEAD:.env`, 'deny');
check('git diff по секрету', `git diff HEAD~1 -- .env`, 'deny');
check('обычный git diff не задет', `git diff HEAD~1 -- src/app.ts`, 'allow');
check('обычный git show не задет', `git show HEAD:package.json`, 'allow');

process.stdout.write('\n--- косвенный вызов ---\n');
check('find -exec cat', `find . -name ".env" -exec cat {} \\;`, 'deny');
check('find -exec обычный', `find . -name "*.ts" -exec wc -l {} \\;`, 'allow');
check('xargs cat', `echo .env | xargs cat`, 'deny');

process.stdout.write('\n--- удалённый хост ---\n');
check('ssh cat секрета', `ssh vps "cat /app/.env"`, 'deny');
check('ssh обычная команда', `ssh vps "df -h"`, 'allow');
check('docker exec printenv', `docker compose exec app printenv`, 'ask');
check('docker exec обычная', `docker compose exec app node -v`, 'allow');

process.stdout.write('\n--- формы пути ---\n');
check('относительный ./', `cat ./.env`, 'deny');
check('родительский каталог', `cat ../vpn-new/.env`, 'deny');
check('абсолютный', `cat /home/enkeym/main/vpn-new/.env`, 'deny');
check('перенос строки как разделитель', `ls -la\ncat .env`, 'deny');
check('&& как разделитель', `pwd && cat .env`, 'deny');

process.stdout.write('\n--- перенаправление ввода ---\n');
check('< без пробела', `cat<.env`, 'deny');
check('цикл read из секрета', `while read l; do echo $l; done < .env`, 'deny');
check('< в незнакомую команду', `mytool < ~/.git-credentials`, 'deny');
check('< обычного файла', `sort < names.txt`, 'allow');
check('< из примера', `cat < .env.example`, 'allow');
check('heredoc не путь', `cat <<EOF > .env\nPORT=3000\nEOF`, 'allow');

process.stdout.write('\n--- грамматика shell ---\n');
check('подстановка $()', `echo $(cat .env)`, 'deny');
check('подстановка в кавычках', `echo "$(cat .env)"`, 'deny');
check('обратные кавычки', 'echo `cat .env`', 'deny');
check('подстановка процесса', `source <(cat .env)`, 'deny');
check('фоновый &', `sleep 1 & cat .env`, 'deny');
check('подоболочка ( )', `(cat .env)`, 'deny');
check('группа { }', `{ cat .env; }`, 'deny');
check('if … then', `if true; then cat .env; fi`, 'deny');
check('for … do', `for i in 1; do cat .env; done`, 'deny');
check('отрицание !', `! cat .env`, 'deny');
check('\\ внутри одинарных кавычек', `echo 'x\\'; cat .env`, 'deny');
check('eval', `eval cat .env`, 'deny');

process.stdout.write('\n--- обёртки с опциями ---\n');
check('sudo -u', `sudo -u root cat .env`, 'deny');
check('env -i', `env -i cat .env`, 'deny');
check('nice', `nice cat .env`, 'deny');
check('exec', `exec cat .env`, 'deny');
check('timeout с единицей', `timeout 5s cat .env`, 'deny');
check('xargs -0', `find . -name .env -print0 | xargs -0 cat`, 'deny');
check('ssh -p', `ssh -p 2222 vps cat /app/.env`, 'deny');
check('ssh -i', `ssh -i ~/.ssh/id_vps vps "cat /app/.env"`, 'deny');
check('ssh с bash -c', `ssh vps bash -c "'cat /app/.env'"`, 'deny');
check('docker exec -u', `docker exec -u root web cat .env`, 'deny');
check('docker exec -e', `docker exec -e A=1 web cat .env`, 'deny');
check('docker run', `docker run --rm -v $PWD:/w alpine cat /w/.env`, 'deny');
check('kubectl exec -n', `kubectl exec -n prod pod -- cat .env`, 'deny');
check('kubectl exec -c после цели', `kubectl exec pod -c app -- cat .env`, 'deny');

process.stdout.write('\n--- окружение целиком ---\n');
check('sudo env', `sudo env`, 'ask');
check('export -p', `export -p`, 'ask');
check('declare -x', `declare -x`, 'ask');
check('printenv -0', `printenv -0`, 'ask');
check('printenv одной переменной', `printenv HOME`, 'allow');
check('set -e не печатает', `set -e`, 'allow');
check('export переменной', `export PORT=3000`, 'allow');

process.stdout.write('\n--- ложные срабатывания разбора ---\n');
check('2>&1 не фон', `cat names.txt 2>&1 | head`, 'allow');
check('&> не фон', `npm test &> /tmp/log`, 'allow');
check('массив', `a=(1 2); echo $a`, 'allow');
check('арифметика', `echo $((1+2))`, 'allow');
check('process\\.env в grep', `grep -rn 'process\\.env' src`, 'allow');
check('ssh без команды', `ssh -p 2222 vps`, 'allow');
check('docker run обычный', `docker run --rm -v $PWD:/w alpine ls /w`, 'allow');
check('подстановка ветки', `echo $(git branch --show-current)`, 'allow');

process.stdout.write('\n--- ложные срабатывания недопустимы ---\n');
// Коммит спрашивает по своей причине (создание коммита), но не запрещает:
// `.env` в тексте сообщения — не чтение секрета.
check('упоминание в сообщении коммита', `git commit -m "добавил .env.example"`, 'ask');
check('создание из примера', `cp .env.example .env`, 'allow');
check('проверка существования', `test -f .env && echo есть`, 'allow');
check('добавление переменной', `echo "PORT=3000" >> .env`, 'allow');
check('чтение примера', `cat .env.example`, 'allow');
check('обычный запуск тестов', `pnpm test -- --ci`, 'allow');

process.stdout.write('\n--- длинная команда ---\n');
{
  // Квадратичный поиск путей разбирал 100 КБ за 12 секунд; хук живёт 60.
  const t0 = Date.now();
  const got = verdict(`git commit -m "${'a'.repeat(200000)}"`);
  const ms = Date.now() - t0;
  const ok = got === 'ask' && ms < 2000;
  process.stdout.write(`${ok ? 'ok  ' : 'FAIL'} коммит в 200 КБ: ${got}, ${ms} мс\n`);
  if (!ok) failed++;
}

process.stdout.write(failed ? `\n=== ${failed} FAIL ===\n` : '\n=== все проверки прошли ===\n');
process.exit(failed ? 1 : 0);
