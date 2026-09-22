// Изоляция побочных эффектов тестов, которые запускают настоящие хук-скрипты:
// журналы и состояние уводятся во временный каталог, фоновый доктор
// выключается. Без этого каждый прогон test-security дописывал бы сотню
// выдуманных запретов в ~/.ai-hooks/logs/hooks.jsonl, рассинхроны из
// test-guards — в guard.log, метки предохранителя и дедупа — в
// ~/.claude/state живых сессий, а сценарий с открытым предохранителем
// запускал бы настоящую headless-сессию claude. Тест со своей песочницей
// переопределяет переменные поверх — так и было.
//
// Импортировать ПЕРВЫМ: hooklog-core и state-core читают переменные при загрузке.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-hooks-test-'));
process.env.AI_HOOKS_HOOKS_LOG = path.join(dir, 'hooks.jsonl');
process.env.AI_HOOKS_LOG_DIR = path.join(dir, 'logs');
process.env.AI_HOOKS_GUARD_LOG = path.join(dir, 'logs', 'guard.log');
process.env.AI_HOOKS_STATE_DIR = path.join(dir, 'state');
process.env.AI_HOOKS_DOCTOR_OFF = '1';

export const ISOLATED_HOOKS_LOG = process.env.AI_HOOKS_HOOKS_LOG;
