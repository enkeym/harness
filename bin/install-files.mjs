import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

function installedLink(target, source) {
  try {
    return fs.lstatSync(target).isSymbolicLink() && fs.realpathSync(target) === fs.realpathSync(source);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return false;
  }
}

function save(target, text, check) {
  const exists = fs.existsSync(target);
  if (!exists) {
    try {
      if (fs.lstatSync(target).isSymbolicLink()) throw new Error(`Dangling configuration link preserved: ${target}`);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  if (exists && fs.readFileSync(target, 'utf8') === text) return 0;
  if (check) {
    console.error(`✗ ${target} — требуется объединение настроек harness`);
    return 1;
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  if (exists) fs.copyFileSync(target, `${target}.bak-${Date.now()}-${randomUUID()}`, fs.constants.COPYFILE_EXCL);
  fs.writeFileSync(target, text, { mode: 0o600 });
  return 0;
}

export function harnessLinks(home) {
  return [
    [path.join(home, '.ai-hooks'), 'ai-hooks'],
    [path.join(home, '.config/harness/repo'), '.'],
    [path.join(home, '.config/harness/bashrc'), 'shell/harness.bash'],
    [path.join(home, '.local/bin/ragsave'), 'bin/ragsave'],
  ];
}

export function skillLinks(root, directory, { shared = false } = {}) {
  return fs.readdirSync(path.join(root, 'skills'))
    .filter((name) => (shared && name === 'shared') || fs.existsSync(path.join(root, 'skills', name, 'SKILL.md')))
    .map((name) => [path.join(directory, name), `skills/${name}`]);
}

export function installDefaults(target, source, check) {
  if (fs.existsSync(target)) return 0;
  return save(target, fs.readFileSync(source, 'utf8'), check);
}

export function installLink(target, source, check) {
  if (installedLink(target, source)) return 0;
  let stat;
  try { stat = fs.lstatSync(target); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (stat) {
    console.error(`✗ ${target} — существующий файл или ссылка сохранены; устраните конфликт установки`);
    return 1;
  }
  if (check) {
    console.error(`✗ ${target} — требуется установка`);
    return 1;
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.symlinkSync(source, target);
  console.log(`✓ ${target} → ${source}`);
  return 0;
}
