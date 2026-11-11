import os from 'node:os';
import path from 'node:path';

export const expandHome = (value) => value.startsWith('~/') ? path.join(os.homedir(), value.slice(2)) : value;
