import { GantusError } from './config.mjs';

const STRICT_KEY = /(^|[^A-Za-z0-9])(STR-\d+)(?![0-9A-Za-z])/g;
const TASK_KEY = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export function isTaskKey(value) {
  return typeof value === 'string' && TASK_KEY.test(value);
}

export function branchKeys(branch) {
  const keys = new Set();
  for (const match of branch.matchAll(STRICT_KEY)) keys.add(match[2]);
  return [...keys];
}

export function singleTaskKey(branch, expected) {
  const keys = branchKeys(branch);
  if (keys.length === 0) {
    throw new GantusError(`в ветке ${branch} нет ключа STR`, 'ambiguous');
  }
  if (keys.length > 1) {
    throw new GantusError(`в ветке ${branch} несколько ключей STR; действие отменено`, 'ambiguous');
  }
  if (keys[0] !== expected) {
    throw new GantusError(`ключ ветки ${keys[0]} не совпадает с задачей ${expected}`, 'ambiguous');
  }
  return keys[0];
}
