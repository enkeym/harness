#!/usr/bin/env node
// Claude Code, PostToolUse на инструментах чтения и правки: подключает файл
// домена из карты неявных связей, когда тронутый путь попал в его `paths:`.
//
// Зачем хук, а не path-scoped правило .claude/rules. Проверено зондом: такое
// правило срабатывает на встроенном Read и молчит на mcp__tokensave__tokensave_read,
// а read-router принуждает к tokensave_read для всех проиндексированных файлов —
// правило не сработало бы ни разу на коде. Хук смотрит на путь из tool_input и
// не зависит от того, какой инструмент его открыл.
//
// Не гард: ничего не запрещает, только добавляет контекст. Молчит, когда:
//   путь не в репозитории или у репозитория нет карты → нечего подключать;
//   ни один глоб `paths:` не совпал                     → домен не тронут;
//   домен в этой сессии уже подключали                 → дроссель, файл уже в контексте.
// Любая ошибка → выход без вывода: пропущенная подсказка дешевле сломанного хода.

import fs from 'node:fs';
import path from 'node:path';
import { repoRoot, statePath, projectKey } from '../state-core.mjs';
import { bodyOf, domainFiles, mapDirOf, pathsOf } from '../links-core.mjs';

const STATE_DIR = statePath('links-context');

// Путь тронутого файла: Read/Edit/Write — file_path, tokensave_read — file,
// tokensave_str_replace — path. Ответ tokensave_body называет файл символа в
// поле `file` — оттуда берём, когда во входе пути нет.
function touchedFile(input) {
  const ti = input.tool_input || {};
  const fromInput = ti.file_path || ti.file || ti.path;
  if (fromInput) return String(fromInput);
  const m = JSON.stringify(input.tool_response || '').match(/\\?"file\\?":\s*\\?"([^"\\]+)/);
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
      `Карта неявных связей: правка попала в домен \`${file}\`. Эти связи граф не видит —`,
      'сверь с ними изменение, а новую связь допиши в этот файл строкой того же формата.',
      '',
      body,
    ].join('\n'))
    .join('\n\n');
}

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => { raw += c; });
process.stdin.on('end', () => {
  try {
    const input = JSON.parse(raw);
    const touched = touchedFile(input);
    if (!touched) process.exit(0);

    const cwd = input.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd();
    const file = path.resolve(cwd, touched);
    const root = repoRoot(path.dirname(file));
    if (!root) process.exit(0);
    const mapDir = mapDirOf(root);
    if (!mapDir) process.exit(0);

    const rel = path.relative(root, file).split(path.sep).join('/');
    if (rel.startsWith('..')) process.exit(0);

    const sessionId = String(input.session_id || 'default');
    const hits = matchedDomains(root, mapDir, rel).filter((h) => !shown(sessionId, root, h.domain));
    if (!hits.length) process.exit(0);

    process.stdout.write(JSON.stringify({
      hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: render(hits) },
    }));
  } catch {
    // подсказка не должна ломать ход
  }
  process.exit(0);
});
