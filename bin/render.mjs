#!/usr/bin/env node
// Шаблоны `*.tmpl` → рабочие файлы рядом с ними (без `.tmpl`).
//
// В шаблонах машинно-зависимые значения записаны как {{HARNESS_…}}: домашний
// каталог, путь к харнессу, git-identity, бинари. Значения берутся по
// приоритету: окружение → harness.env (локальный, в .gitignore) →
// harness.env.example (значения по умолчанию, в репозитории). В значениях
// можно ссылаться на другие переменные: ${HARNESS_USER_HOME}/.local/share/pnpm.
//
// Рабочие файлы в .gitignore: в них личные пути и почта. Правится шаблон.
//
//   node bin/render.mjs [--root DIR]          отрендерить; изменённый руками
//                                             файл уезжает в <имя>.bak-<дата>
//   node bin/render.mjs [--root DIR] --check  только отчёт; код 1 при расхождении
//   node bin/render.mjs [--root DIR] --get X  напечатать значение переменной

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const opt = (name) => {
  const i = args.indexOf(name);
  return i === -1 ? null : args[i + 1];
};
const ROOT = path.resolve(opt('--root') ?? path.join(path.dirname(fileURLToPath(import.meta.url)), '..'));
const CHECK = args.includes('--check');
const GET = opt('--get');

const good = (s) => console.log(`  \x1b[32m✓\x1b[0m ${s}`);
const warn = (s) => console.log(`  \x1b[33m!\x1b[0m ${s}`);
const bad = (s) => console.log(`  \x1b[31m✗\x1b[0m ${s}`);

// KEY=value, пустые строки и # — комментарии, кавычки вокруг значения снимаются.
function parseEnv(file) {
  if (!fs.existsSync(file)) return {};
  const out = {};
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const m = line.match(/^\s*(?:export\s+)?([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!m) continue;
    out[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
  return out;
}

function loadVars() {
  const raw = {
    ...parseEnv(path.join(ROOT, 'harness.env.example')),
    ...parseEnv(path.join(ROOT, 'harness.env')),
  };
  for (const key of Object.keys(raw)) {
    if (process.env[key] !== undefined) raw[key] = process.env[key];
  }
  // ${VAR} раскрываются после слияния: переопределённый HARNESS_USER_HOME
  // тянет за собой всё, что из него выведено по умолчанию.
  const resolved = {};
  const resolve = (key, stack = []) => {
    if (key in resolved) return resolved[key];
    if (stack.includes(key)) throw new Error(`цикл в переменных: ${[...stack, key].join(' → ')}`);
    if (!(key in raw)) return process.env[key] ?? '';
    resolved[key] = raw[key].replace(/\$\{([A-Z_][A-Z0-9_]*)\}/g, (_, ref) => resolve(ref, [...stack, key]));
    return resolved[key];
  };
  for (const key of Object.keys(raw)) resolve(key);
  return resolved;
}

function findTemplates(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === '.git' || entry.name === 'node_modules') continue;
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) findTemplates(p, out);
    else if (entry.isFile() && entry.name.endsWith('.tmpl')) out.push(p);
  }
  return out.sort();
}

const vars = loadVars();

if (GET) {
  process.stdout.write(vars[GET] ?? process.env[GET] ?? '');
  process.exit(0);
}

const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
let drift = 0;

for (const tmpl of findTemplates(ROOT)) {
  const out = tmpl.slice(0, -'.tmpl'.length);
  const rel = path.relative(ROOT, out);
  const unknown = new Set();
  const text = fs.readFileSync(tmpl, 'utf8').replace(/\{\{([A-Z_][A-Z0-9_]*)\}\}/g, (m, key) => {
    if (key in vars) return vars[key];
    unknown.add(key);
    return m;
  });
  if (unknown.size) {
    bad(`${rel} — нет значения для ${[...unknown].join(', ')} (добавить в harness.env.example)`);
    drift++;
    continue;
  }
  const current = fs.existsSync(out) ? fs.readFileSync(out, 'utf8') : null;
  if (current === text) {
    good(rel);
    continue;
  }
  if (CHECK) {
    warn(current === null ? `${rel} — не отрендерен` : `${rel} — расходится с шаблоном (правка руками или устаревший рендер)`);
    drift++;
    continue;
  }
  // Файл, который правили руками (Claude Code переписывает settings.json через
  // /config), не затирается молча — как и в install.sh, уезжает в бэкап.
  if (current !== null) {
    fs.renameSync(out, `${out}.bak-${stamp}`);
    warn(`${rel} — отличался от шаблона, сохранён как ${path.basename(out)}.bak-${stamp}`);
  }
  // Режим шаблона переносится: исполняемые скрипты остаются исполняемыми.
  fs.writeFileSync(out, text, { mode: fs.statSync(tmpl).mode & 0o777 });
  good(`${rel} ← ${path.basename(tmpl)}`);
}

process.exit(drift ? 1 : 0);
