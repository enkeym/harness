// Изоляция побочных эффектов тестов, которые запускают настоящие хук-скрипты:
// журналы и состояние уводятся во временный каталог. Без этого каждый прогон
// test-security дописывал бы сотню выдуманных запретов в
// ~/.ai-hooks/logs/hooks.jsonl, а метки — в ~/.claude/state живых сессий.
// Тест со своей песочницей переопределяет переменные поверх — так и было.
//
// Импортировать ПЕРВЫМ: hooklog-core и state-core читают переменные при загрузке.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-hooks-test-'));
process.env.AI_HOOKS_HOOKS_LOG = path.join(dir, 'hooks.jsonl');
process.env.AI_HOOKS_LOG_DIR = path.join(dir, 'logs');
process.env.AI_HOOKS_STATE_DIR = path.join(dir, 'state');
// Сессия живого Claude Code, из которого запущен тест: иначе ask-mode.mjs
// в тестах писал бы режим под её session_id, а не под ключ теста.
delete process.env.CLAUDE_CODE_SESSION_ID;

export const ISOLATED_HOOKS_LOG = process.env.AI_HOOKS_HOOKS_LOG;
