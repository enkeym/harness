#!/usr/bin/env node
// Подмена tokensave и ragsave для теста bin/project-init.sh. Имя бинаря — имя
// симлинка на этот файл (`tokensave` или `ragsave`): argv с ним дописывается
// строкой JSON в FAKE_INIT_CALLS. Успешный init создаёт БД индекса, как
// настоящий, sync снимает метку .tokensave/dirty прерванного init.
// FAKE_INIT_FAIL=<имя> — этот бинарь печатает строку и падает с кодом 1, ничего не создав.
import fs from 'node:fs';
import path from 'node:path';

const name = path.basename(process.argv[1]);
const args = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_INIT_CALLS, `${JSON.stringify([name, ...args])}\n`);
process.stdout.write(`fake ${name} ${args.join(' ')}\n`);
if (process.env.FAKE_INIT_FAIL === name) process.exit(1);

const [cmd, root] = args;
const db = { tokensave: ['.tokensave', 'tokensave.db'], ragsave: ['.ragsave', 'rag.db'] }[name];
if (cmd === 'init') {
  fs.mkdirSync(path.join(root, db[0]), { recursive: true });
  fs.writeFileSync(path.join(root, ...db), '');
}
if (cmd === 'sync') fs.rmSync(path.join(root, '.tokensave', 'dirty'), { force: true });
