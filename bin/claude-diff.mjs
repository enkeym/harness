#!/usr/bin/env node
// Что в прежнем settings.json или keybindings.json Claude Code есть своего —
// того, чего нет в файле харнесса. install.sh зовёт его на бэкап, который
// увёз link_one (в --check — на живую цель), и показывает строки отчётом;
// переносит их в харнесс /doctor.
//
//   node bin/claude-diff.mjs <старый> <харнесс>
//
// По строке на пункт, код 0. Значения не печатаются там, где бывают секреты:
// под `env` — только имя, у скаляра — только путь. `model` пропускается: его
// ведёт /model, и в git он не попадает (фильтр nomodel).

import fs from 'node:fs';
import path from 'node:path';

const [oldFile, ownFile] = process.argv.slice(2);

// Пустой файл — пустой объект: так его и читает Claude Code.
const parse = (file) => {
  const text = fs.readFileSync(file, 'utf8');
  return text.trim() ? JSON.parse(text) : {};
};

let old;
try {
  old = parse(oldFile);
} catch {
  console.log(`${path.basename(oldFile)} не разобран как JSON — сравнить руками`);
  process.exit(0);
}
let own;
try {
  own = parse(ownFile);
} catch {
  own = {};
}

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const join = (p, key) => (p ? `${p}.${key}` : key);
const item = (v) => (typeof v === 'string' ? v : JSON.stringify(v));

// Хук узнаётся по команде: у хуков tokensave бинарь в command, подкоманда в args.
// Хук без command (`type: prompt`) — по нему целиком.
const hookKey = (h) => (h?.command ? [h.command, ...(h.args ?? [])].join(' ') : item(h));
const hookList = (groups) =>
  (Array.isArray(groups) ? groups : []).flatMap((g) =>
    (Array.isArray(g?.hooks) ? g.hooks : []).map((h) => ({ matcher: g.matcher, key: hookKey(h) })));

function hooks(oldEvents, ownEvents) {
  for (const [event, groups] of Object.entries(oldEvents)) {
    const have = new Set(hookList(ownEvents?.[event]).map((h) => `${h.matcher}\n${h.key}`));
    for (const h of hookList(groups)) {
      if (have.has(`${h.matcher}\n${h.key}`)) continue;
      console.log(`hooks.${event}${h.matcher === undefined ? '' : `[${h.matcher}]`}: ${h.key}`);
    }
  }
}

// Блоки keybindings — массив объектов с `context`: сверяются по нему, а не по
// позиции, и путь короче — bindings[Chat].meta+x.
const byContext = (arr) => arr.length > 0 && arr.every((el) => isObject(el) && typeof el.context === 'string');

function walk(a, b, p) {
  if (isObject(a)) {
    for (const [key, val] of Object.entries(a)) {
      if (!p && key === 'model') continue;
      const sub = isObject(b) ? b[key] : undefined;
      if (!p && key === 'env' && isObject(val)) {
        for (const [name, v] of Object.entries(val)) if (!isObject(sub) || sub[name] !== v) console.log(`env.${name}`);
      } else if (!p && key === 'hooks' && isObject(val)) {
        hooks(val, sub);
      } else {
        walk(val, sub, join(p, key));
      }
    }
    return;
  }
  if (Array.isArray(a)) {
    const theirs = Array.isArray(b) ? b : [];
    if (byContext(a)) {
      for (const el of a) {
        const mine = theirs.find((x) => x?.context === el.context);
        walk(el.bindings, mine?.bindings, `${p}[${el.context}]`);
      }
      return;
    }
    const have = new Set(theirs.map((x) => JSON.stringify(x)));
    for (const el of a) if (!have.has(JSON.stringify(el))) console.log(`${p}: ${item(el)}`);
    return;
  }
  if (JSON.stringify(a) === JSON.stringify(b)) return;
  console.log(b === undefined ? p : `${p} — другое значение`);
}

walk(old, own, '');
