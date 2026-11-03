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

export function installInstructions(target, source, check) {
  if (installedLink(target, source)) return 0;
  const text = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : '';
  const start = '\n# Harness managed instructions\n';
  const end = '\n# End harness managed instructions\n';
  const first = text.indexOf(start);
  const last = text.indexOf(end);
  if ((first < 0) !== (last < 0) || (first >= 0 && (last < first || text.indexOf(start, first + start.length) >= 0 || text.indexOf(end, last + end.length) >= 0))) throw new Error(`Invalid harness section: ${target}`);
  const block = start + '\n' + fs.readFileSync(source, 'utf8').trimEnd() + '\n' + end;
  const desired = first < 0 ? text + (text && !text.endsWith('\n') ? '\n' : '') + block : text.slice(0, first) + block + text.slice(last + end.length);
  return save(target, desired, check);
}

function readManagedHooks(file) {
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : { hooks: {} };
}

function removeManagedHooks(current, managed) {
  const hooks = { ...current };
  for (const [event, groups] of Object.entries(managed)) {
    const commands = new Set(groups.flatMap(group => group.hooks.map(hook => hook.command)).filter(command => typeof command === 'string'));
    if (!commands.size || !hooks[event]) continue;
    hooks[event] = hooks[event].map(group => ({ ...group, hooks: group.hooks.filter(hook => !commands.has(hook.command)) })).filter(group => group.hooks.length);
    if (!hooks[event].length) delete hooks[event];
  }
  return hooks;
}

export function installHooks(target, source, check) {
  if (installedLink(target, source)) return 0;
  const desired = JSON.parse(fs.readFileSync(source, 'utf8'));
  const current = fs.existsSync(target) ? JSON.parse(fs.readFileSync(target, 'utf8')) : {};
  const manifest = `${target}.harness-managed.json`;
  const previous = readManagedHooks(manifest);
  for (const value of [current, desired, previous]) {
    if (!value || typeof value !== 'object' || Array.isArray(value) || (value.hooks !== undefined && (!value.hooks || typeof value.hooks !== 'object' || Array.isArray(value.hooks)))) throw new Error(`Invalid hooks: ${target}`);
    for (const groups of Object.values(value.hooks ?? {})) {
      if (!Array.isArray(groups) || groups.some(group => !Array.isArray(group?.hooks))) throw new Error(`Invalid hook groups: ${target}`);
    }
  }
  const managed = desired.hooks ?? {};
  const hooks = removeManagedHooks(removeManagedHooks(current.hooks ?? {}, previous.hooks ?? {}), managed);
  for (const [event, groups] of Object.entries(managed)) {
    hooks[event] = [...(hooks[event] ?? []), ...groups];
  }
  const merged = { ...desired, ...current, hooks };
  const drift = JSON.stringify(current) === JSON.stringify(merged) ? 0 : save(target, JSON.stringify(merged, null, 2) + '\n', check);
  return Math.max(drift, save(manifest, JSON.stringify({ hooks: managed }, null, 2) + '\n', check));
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
