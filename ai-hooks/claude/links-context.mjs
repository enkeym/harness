#!/usr/bin/env node
// Claude Code, PostToolUse на инструментах правки: подключает файл домена из
// карты неявных связей, когда правленый путь попал в его `paths:`. На чтении
// молчит: карта нужна для сверки правки, а сессия без правок платила бы за
// домен целиком (~1,4k токенов) ни за что.
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
//   домен в этой сессии уже подключали                 → дроссель, файл уже в контексте.
// Любая ошибка → выход без вывода: пропущенная подсказка дешевле сломанного хода.

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

// Один домен в одной сессии подключаем один раз: второй показ — тот же текст в
// контексте дважды. Метка не критична: не записалась — покажем ещё раз.
function shown(sessionId, root, domain) {
  const key = `${sessionId}-${projectKey(root)}-${domain.replace(/[^\w.-]/g, '_')}`;
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

function render(hits) {
  return hits
    .map(({ file, body }) => [
      `Карта неявных связей \`${file}\`: сверь с ней правку, новую связь допиши туда строкой того же формата.`,
      '',
      body,
    ].join('\n'))
    .join('\n\n');
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
  const hits = matchedDomains(root, mapDir, rel).filter((h) => !shown(sessionId, root, h.domain));
  return hits.length ? { context: render(hits) } : null;
}

if (isEntryPoint(import.meta.url)) runHook(check, 'PostToolUse');
