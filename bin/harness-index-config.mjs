#!/usr/bin/env node
// Исправляет только известное исключение исходников собственного харнеса.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const file = path.join(root, '.tokensave/config.json');
if (fs.existsSync(file)) {
  const config = JSON.parse(fs.readFileSync(file, 'utf8'));
  const exclude = (config.exclude ?? []).filter((pattern) => pattern !== 'bin/**');
  if (exclude.length !== (config.exclude ?? []).length) {
    if (process.argv.includes('--check')) {
      console.error('TokenSave исключает bin/** харнеса; запусти node bin/harness-index-config.mjs и tokensave sync -f');
      process.exitCode = 1;
    } else {
      config.exclude = exclude;
      fs.writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`);
      console.log('TokenSave: исходники bin/** включены; обнови существующий индекс');
    }
  }
}
