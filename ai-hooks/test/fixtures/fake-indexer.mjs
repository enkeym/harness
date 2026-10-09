#!/usr/bin/env node
// Подмена tokensave и ragsave для тестов фоновых синков (bin/tokensave-*.sh,
// bin/ragsave-sync.sh): дописывает argv строкой JSON в FAKE_INDEXER_CALLS —
// по этому файлу тест дожидается фонового setsid, — печатает строку в лог
// синка и выходит с кодом FAKE_INDEXER_EXIT (по умолчанию 0). С FAKE_INDEXER_CWD
// ещё дописывает туда свой рабочий каталог — так bin/mcp-serve.sh проверяет,
// в каком корне поднят сервер.
import fs from 'node:fs';

const args = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_INDEXER_CALLS, `${JSON.stringify(args)}\n`);
if (process.env.FAKE_INDEXER_CWD) fs.appendFileSync(process.env.FAKE_INDEXER_CWD, `${process.cwd()}\n`);
process.stdout.write(`fake ${args.join(' ')}\n`);
process.exit(Number(process.env.FAKE_INDEXER_EXIT || 0));
