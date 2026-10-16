#!/usr/bin/env node
// Claude Code, PostToolUse на инструментах правки: когда правленый путь попал в
// `paths:` файла домена карты неявных связей, подключает из него только пункты,
// где назван этот файл или его каталог, и строку «ещё N пунктов». Карта целиком
// стоила 93% всего текста хуков (медиана 5k символов на сессию, до 70k), а
// полную карту всё равно читает review-standards перед коммитом. Ни один пункт
// не назвал файл — одна строка-указатель на карту. На чтении молчит: карта
// нужна для сверки правки.
//
// Зачем хук, а не path-scoped правило .claude/rules. Проверено зондом: такое
// правило срабатывает на встроенном Read и молчит на mcp__tokensave__tokensave_read,
// а read-router принуждает к tokensave_read для всех проиндексированных файлов —
// правило не сработало бы ни разу на коде. Хук смотрит на путь из tool_input и
// не зависит от того, какой инструмент его открыл.
//
// Не гард: ничего не запрещает, только добавляет контекст. Молчит, когда:
//   инструмент не правит файл                          → сверять нечего;
//   путь не в репозитории или у репозитория нет карты → нечего подключать;
//   ни один глоб `paths:` не совпал                     → домен не тронут;
//   пункт в этой сессии уже показан                    → дроссель, он уже в контексте;
//   указатель на домен в этой сессии уже был          → то же.
// Любая ошибка → выход без вывода: пропущенная подсказка дешевле сломанного хода.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { repoRoot, statePath, projectKey, isEntryPoint } from '../state-core.mjs';
import { bodyOf, domainFiles, mapDirOf, pathsOf } from '../links-core.mjs';
import { runHook } from './hook-io.mjs';

const STATE_DIR = statePath('links-context');

// Та же выборка, что matcher links-context в claude/dispatch.mjs: там — чтобы не
// грузить модуль на каждом чтении, здесь — чтобы правило проверялось тестом.
const EDIT_TOOL_RE =
  /^(Edit|Write|MultiEdit|mcp__tokensave__tokensave_(str_replace|multi_str_replace|replace_lines|insert_at|insert_at_symbol|replace_symbol))$/;

// Путь правленого файла: Edit/Write — file_path, tokensave_str_replace,
// replace_lines и insert_at — path. replace_symbol и insert_at_symbol пути на входе не несут —
// берём `file`/`file_path` из ответа.
function touchedFile(input) {
  const ti = input.tool_input || {};
  const fromInput = ti.file_path || ti.path;
  if (fromInput) return String(fromInput);
  const m = JSON.stringify(input.tool_response || '').match(/\\?"file(?:_path)?\\?":\s*\\?"([^"\\]+)/);
  return m ? m[1] : null;
}

// Пункт или указатель на домен в одной сессии показываем один раз: второй показ —
// тот же текст в контексте дважды. Метка не критична: не записалась — покажем ещё раз.
function shown(sessionId, root, mark) {
  const key = `${sessionId}-${projectKey(root)}-${mark.replace(/[^\w.-]/g, '_')}`;
  const stamp = path.join(STATE_DIR, key);
  if (fs.existsSync(stamp)) return true;
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.writeFileSync(stamp, '');
  } catch {
    // не смогли записать — не повод молчать
  }
  return false;
}

function matchedDomains(root, mapDir, rel) {
  const hits = [];
  for (const domain of domainFiles(mapDir)) {
    const text = fs.readFileSync(path.join(mapDir, domain), 'utf8');
    const globs = pathsOf(text);
    if (!globs || !globs.some((g) => path.matchesGlob(rel, g))) continue;
    hits.push({ domain, file: path.relative(root, path.join(mapDir, domain)), body: bodyOf(text).trim() });
  }
  return hits;
}

// Пункт карты — строка `- ` и строки с отступом под ней, до пустой строки,
// заголовка или следующего пункта. Заголовок раздела идёт с пунктом: без него
// пункт вырван из контекста.
function itemsOf(body) {
  const items = [];
  let heading = '';
  let item = null;
  for (const line of body.split('\n')) {
    if (line.startsWith('#')) {
      heading = line;
      item = null;
    } else if (line.startsWith('- ')) {
      item = { heading, lines: [line] };
      items.push(item);
    } else if (item && /^\s+\S/.test(line)) {
      item.lines.push(line);
    } else {
      item = null;
    }
  }
  return items.map(({ heading, lines }) => ({ heading, text: lines.join('\n') }));
}

const PATH_CHAR = String.raw`[\w./*-]`;
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Пункт задевает файл, когда называет его путь целиком (`a/b.mjs`, `a/b.mjs:fn`),
// один из его каталогов как целое (`a/` или `a` в обратных кавычках, но не
// `a/c.mjs` и не слово «a» в тексте) или глоб в обратных кавычках, под который
// файл попадает (`a/**`, `a/test-*.mjs`).
function mentionTest(rel) {
  const parts = rel.split('/');
  const dirs = parts.slice(0, -1).map((_, i) => escapeRe(parts.slice(0, i + 1).join('/')));
  const named = [escapeRe(rel), ...dirs.map((d) => `${d}/`)].join('|');
  const quoted = dirs.length ? `|\`(?:${dirs.join('|')})\`` : '';
  const re = new RegExp(`(?<!${PATH_CHAR})(?:${named})(?!${PATH_CHAR})${quoted}`);
  return (text) =>
    re.test(text) ||
    [...text.matchAll(/`([^`\s]*\*[^`\s]*)`/g)].some((m) => path.matchesGlob(rel, m[1].replace(/:.*$/, '')));
}

const digest = (text) => crypto.createHash('sha1').update(text).digest('hex').slice(0, 12);

function renderItems(file, rel, items, rest) {
  const lines = [
    `Implicit-links map \`${file}\`, items naming \`${rel}\`: check the edit against them; add a new link there in the same format.`,
  ];
  let heading = null;
  for (const item of items) {
    if (item.heading && item.heading !== heading) lines.push('', item.heading);
    heading = item.heading;
    lines.push(item.text);
  }
  if (rest) lines.push('', `${rest} more items in \`${file}\` do not name this file.`);
  return lines.join('\n');
}

function renderPointer(file, rel, total) {
  return `\`${rel}\` is covered by the implicit-links map \`${file}\` (${total} items, none names this file): read it if the edit changes a contract between modules; add a new link there in the same format.`;
}

export function check(input) {
  if (!EDIT_TOOL_RE.test(String(input.tool_name || ''))) return null;
  const touched = touchedFile(input);
  if (!touched) return null;

  const cwd = input.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const file = path.resolve(cwd, touched);
  const root = repoRoot(path.dirname(file));
  if (!root) return null;
  const mapDir = mapDirOf(root);
  if (!mapDir) return null;

  const rel = path.relative(root, file).split(path.sep).join('/');
  if (rel.startsWith('..')) return null;

  const sessionId = String(input.session_id || 'default');
  const mentions = mentionTest(rel);
  const parts = [];
  for (const { domain, file, body } of matchedDomains(root, mapDir, rel)) {
    const items = itemsOf(body);
    const hits = items.filter((item) => mentions(item.text));
    const fresh = hits.filter((item) => !shown(sessionId, root, `${domain}#${digest(item.text)}`));
    if (fresh.length) parts.push(renderItems(file, rel, fresh, items.length - hits.length));
    else if (!hits.length && !shown(sessionId, root, domain)) parts.push(renderPointer(file, rel, items.length));
  }
  return parts.length ? { context: parts.join('\n\n') } : null;
}

if (isEntryPoint(import.meta.url)) runHook(check, 'PostToolUse');
