// Изоляция побочных эффектов тестов, которые запускают настоящие хук-скрипты:
// журнал решений уводится во временный файл, фоновый доктор выключается.
// Без этого каждый прогон test-security дописывал бы сотню выдуманных
// запретов в ~/.ai-hooks/logs/hooks.jsonl, а сценарий с открытым
// предохранителем запускал бы настоящую headless-сессию claude.
//
// Импортировать ПЕРВЫМ: hooklog-core читает AI_HOOKS_HOOKS_LOG при загрузке.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-hooks-test-'));
process.env.AI_HOOKS_HOOKS_LOG = path.join(dir, 'hooks.jsonl');
process.env.AI_HOOKS_DOCTOR_OFF = '1';

export const ISOLATED_HOOKS_LOG = process.env.AI_HOOKS_HOOKS_LOG;
