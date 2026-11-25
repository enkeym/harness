import { GantusError } from './config.mjs';

const COMMAND_FLAGS = new Map([
  ['get', ['key']],
  ['create', ['name', 'desc', 'priority', 'start', 'end']],
  ['edit', ['key', 'name', 'desc', 'priority']],
  ['comment', ['key', 'body']],
  ['move', ['key', 'column', 'to']],
  ['preflight', ['key']],
  ['review-lookup', ['branch']],
  ['sync', [
    'key', 'mr', 'desc', 'desc-file', 'qa', 'qa-file', 'gitlab-user-id',
    'expected-desc', 'expected-desc-file', 'expected-mr-desc', 'expected-mr-desc-file',
    'expected-card-id', 'replaced-desc', 'replaced-desc-file'
  ]],
  ['review-ready', ['key', 'mr']],
  ['rename-branch', ['key', 'branch']]
]);

export function parseArgs(argv) {
  const [command, ...rest] = argv;
  const allowed = COMMAND_FLAGS.get(command);
  if (!allowed) {
    throw new GantusError(`неизвестная команда; доступны: ${[...COMMAND_FLAGS.keys()].join(', ')}`, 'usage');
  }
  const flags = {};
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (!token.startsWith('--') || token.length === 2) {
      throw new GantusError('ожидался именованный флаг', 'usage');
    }
    const separator = token.indexOf('=');
    const name = separator === -1 ? token.slice(2) : token.slice(2, separator);
    if (!allowed.includes(name)) {
      throw new GantusError('команда не принимает один из указанных флагов', 'usage');
    }
    if (Object.hasOwn(flags, name)) {
      throw new GantusError(`повторяющийся флаг: --${name}`, 'usage');
    }
    if (separator !== -1) {
      flags[name] = token.slice(separator + 1);
      continue;
    }
    const value = rest[index + 1];
    if (value === undefined || value.startsWith('--')) {
      throw new GantusError(`флаг --${name} требует значение`, 'usage');
    }
    flags[name] = value;
    index += 1;
  }
  return { command, flags };
}
