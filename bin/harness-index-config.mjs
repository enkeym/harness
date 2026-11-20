#!/usr/bin/env node
// Исправляет известные отклонения покрытия собственного индекса TokenSave:
// исключение исходников bin/**, служебные планы/кэш .opencode/ в exclude,
// артефакты .jsonc и extensionless wrapper bin/ragsave (манифест project.json).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dir = path.join(root, '.tokensave');
const file = path.join(dir, 'config.json');
const manifest = path.join(dir, 'project.json');
const check = process.argv.includes('--check');
const serviceExcludes = ['**/.opencode/plans/**', '**/.opencode/context-cache/**'];
const wrapperEntries = [{ path: 'bin/ragsave', language: 'bash' }];
let drift = false;

if (fs.existsSync(file)) {
  const config = JSON.parse(fs.readFileSync(file, 'utf8'));
  const rest = (config.exclude ?? []).filter((pattern) => pattern !== 'bin/**' && !serviceExcludes.includes(pattern));
  const artifacts = (config.artifact_extensions ?? []).filter((ext) => ext !== 'jsonc');
  const next = { ...config, exclude: [...serviceExcludes, ...rest], artifact_extensions: [...artifacts, 'jsonc'] };
  if (JSON.stringify(next) !== JSON.stringify(config)) {
    drift = true;
    if (check) {
      console.error('TokenSave config: покрытие bin/**, служебных .opencode/ и .jsonc отклонено; запусти node bin/harness-index-config.mjs и tokensave sync -f');
    } else {
      fs.writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`);
      console.log('TokenSave: покрытие config восстановлено; обнови существующий индекс (tokensave sync -f)');
    }
  }
}

if (fs.existsSync(dir)) {
  let man = { version: 1, entries: [] };
  if (fs.existsSync(manifest)) {
    try { man = JSON.parse(fs.readFileSync(manifest, 'utf8')); } catch { man = { version: 1, entries: [] }; }
  }
  const entries = [...(man.entries ?? [])];
  for (const entry of wrapperEntries) {
    if (!entries.some((m) => m.path === entry.path && m.language === entry.language)) entries.push(entry);
  }
  const next = { ...man, version: 1, entries };
  if (JSON.stringify(next) !== JSON.stringify(man)) {
    drift = true;
    if (check) {
      console.error('TokenSave манифест: extensionless wrapper не описан в .tokensave/project.json; запусти node bin/harness-index-config.mjs и tokensave sync -f');
    } else {
      fs.writeFileSync(manifest, `${JSON.stringify(next, null, 2)}\n`);
      console.log('TokenSave: project.json с wrapper-записями записан; обнови индекс (tokensave sync -f)');
    }
  }
}

if (check && drift) process.exitCode = 1;
