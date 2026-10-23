#!/usr/bin/env node
// Подмена tokensave и ragsave для тестов фоновых синков (bin/tokensave-*.sh,
// bin/ragsave-sync.sh): дописывает argv строкой JSON в FAKE_INDEXER_CALLS —
// по этому файлу тест дожидается фонового setsid, — печатает строку в лог
// синка и выходит с кодом FAKE_INDEXER_EXIT (по умолчанию 0). С FAKE_INDEXER_CWD
// ещё дописывает туда свой рабочий каталог — так bin/mcp-serve.sh проверяет,
// в каком корне поднят сервер. С FAKE_INDEXER_ENV — свой RAGSAVE_THREADS (null — не задан).
// С FAKE_INDEXER_REQ — содержимое файла после `-r`: install.sh --venv отдаёт pip
// список через <(…), и прочесть его может только сам процесс.
import fs from 'node:fs';

const args = process.argv.slice(2);
if (process.env.FAKE_INDEXER_ENV) fs.appendFileSync(process.env.FAKE_INDEXER_ENV, `${JSON.stringify([process.env.RAGSAVE_THREADS ?? null])}\n`);
fs.appendFileSync(process.env.FAKE_INDEXER_CALLS, `${JSON.stringify(args)}\n`);
const req = args.indexOf('-r');
if (process.env.FAKE_INDEXER_REQ && req >= 0) fs.appendFileSync(process.env.FAKE_INDEXER_REQ, fs.readFileSync(args[req + 1], 'utf8'));
if (process.env.FAKE_INDEXER_CWD) fs.appendFileSync(process.env.FAKE_INDEXER_CWD, `${process.cwd()}\n`);
process.stdout.write(`fake ${args.join(' ')}\n`);
process.exit(Number(process.env.FAKE_INDEXER_EXIT || 0));
