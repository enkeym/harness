#!/usr/bin/env node
// Хук, который отдаёт решение из самого входа — проверка respond/decide в hook-io
// без гардов. Поля fixture_* добавляет тест.
import { readInput, respond, decide } from '../../claude/hook-io.mjs';

readInput((input) => {
  if (input.fixture_exit === 'decide') decide(input, input.fixture_decision, input.fixture_reason);
  respond(input, input.fixture_reason);
});
