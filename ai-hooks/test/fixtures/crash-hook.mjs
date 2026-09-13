#!/usr/bin/env node
// Хук, который падает внутри обработчика — проверка захвата падений в hook-io.
import { readInput } from '../../claude/hook-io.mjs';

readInput(() => {
  throw new Error('fixture: намеренное падение хука');
});
