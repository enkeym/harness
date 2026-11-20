import fs from 'node:fs';
import path from 'node:path';
import { expandHome } from './home-path.mjs';

// Голое имя ищется по PATH; --check замечает смену пути, например после nvm.
export function resolveCommand(cmd) {
  if (cmd.includes('/')) return expandHome(cmd);
  for (const dir of (process.env.PATH || '').split(path.delimiter).filter(Boolean)) {
    const file = path.join(dir, cmd);
    try {
      fs.accessSync(file, fs.constants.X_OK);
      if (fs.statSync(file).isFile()) return file;
    } catch { /* нет в этом каталоге */ }
  }
  return null;
}
