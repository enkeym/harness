#!/usr/bin/env node
// Хук, который отдаёт решение из самого входа — проверка runHook в hook-io
// без гардов. Поля fixture_* добавляет тест: fixture_decision — решение,
// без него fixture_reason значит deny.
import { runHook } from '../../claude/hook-io.mjs';

runHook((input) => {
  const decision = input.fixture_exit === 'decide'
    ? input.fixture_decision
    : (input.fixture_reason ? 'deny' : null);
  return decision ? { decision, reason: input.fixture_reason } : null;
}, 'PreToolUse');
