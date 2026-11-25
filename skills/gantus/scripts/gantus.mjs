#!/usr/bin/env node
import { parseArgs } from './args.mjs';
import { GantusError, loadConfig } from './config.mjs';
import { dispatch } from './operations.mjs';

try {
  const parsed = parseArgs(process.argv.slice(2));
  const config = loadConfig(process.env);
  const result = dispatch(parsed, config, process.cwd());
  console.log(JSON.stringify(result));
} catch (error) {
  if (error instanceof GantusError) {
    console.error(`Гантус: ${error.message}`);
    process.exitCode = error.code === 'usage' || error.code === 'config' ? 2 : 1;
  } else {
    console.error('Гантус: непредвиденная ошибка');
    process.exitCode = 1;
  }
}
