#!/usr/bin/env node
// Тесты подмены заглушки tokensave_read: `unchanged: true` из межсессионного
// кэша заменяется текстом файла с диска (full и lines), остальное — тишина.
// Гоняется на временном проекте с пустым .tokensave/tokensave.db как маркером.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const HOOK = path.join(ROOT, 'claude', 'read-refill.mjs');

let failed = 0;
function check(name, ok, detail = '') {
  process.stdout.write(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok || !detail ? '' : ` — ${detail}`}\n`);
  if (!ok) failed++;
}

// `$&` и `$'` — шаблоны String.replace: тело не должно через них пройти.
const SOURCE = 'line1\nline2 $& $\'x\'\nline3\nline4\n';
const MTIME = '1790059790186249587'; // больше 2^53

function project(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'read-refill-test-'));
  fs.mkdirSync(path.join(dir, '.tokensave'));
  fs.writeFileSync(path.join(dir, '.tokensave', 'tokensave.db'), '');
  for (const [rel, body] of Object.entries(files)) {
    const file = path.join(dir, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, body);
  }
  return dir;
}

function stub(file, mode = 'full') {
  return JSON.stringify({ unchanged: true, file, mode, mtime_ns: 0, digest: 'd', token_count: 9 }, null, 2)
    .replace('"mtime_ns": 0', `"mtime_ns": ${MTIME}`);
}

// Ответ MCP так, как его видит хук: массив блоков, второй — строка метрик.
function blocks(text) {
  return [{ type: 'text', text }, { type: 'text', text: 'tokensave_metrics: before=1 after=1 saved=0' }];
}

// Хук стартует из подкаталога — корень индекса ищется вверх, как в mcp-serve.sh.
function run(dir, toolInput, toolResponse) {
  const input = JSON.stringify({
    session_id: `test-${process.pid}`,
    cwd: path.join(dir, 'src'),
    tool_name: 'mcp__tokensave__tokensave_read',
    tool_input: toolInput,
    tool_response: toolResponse,
  });
  const env = { ...process.env, CLAUDE_PROJECT_DIR: path.join(dir, 'src') };
  const r = spawnSync('node', [HOOK], { input, encoding: 'utf8', env });
  if (r.status !== 0) return { error: r.stderr };
  if (!r.stdout) return null;
  return JSON.parse(r.stdout).hookSpecificOutput;
}

const bodyOf = (out, i = 0) => JSON.parse(out.updatedToolOutput[i].text);

const dir = project({ 'src/a.ts': SOURCE });

// full: тело — файл целиком, поля заглушки кроме unchanged сохранены, метрики на месте.
{
  const out = run(dir, { file: 'src/a.ts' }, blocks(stub('src/a.ts')));
  const body = out && bodyOf(out);
  check('full: тело файла вместо заглушки', body?.body === SOURCE, JSON.stringify(out));
  check('full: unchanged снят, file и digest сохранены',
    body && !('unchanged' in body) && body.file === 'src/a.ts' && body.digest === 'd', JSON.stringify(body));
  check('full: mtime_ns без потери цифр', out?.updatedToolOutput[0].text.includes(`"mtime_ns": ${MTIME}`));
  check('full: блок метрик не тронут', out?.updatedToolOutput[1]?.text.startsWith('tokensave_metrics:'));
  check('событие PostToolUse', out?.hookEventName === 'PostToolUse');
}

// lines: диапазон A-B и одиночная строка, 1-based включительно.
{
  const range = run(dir, { file: 'src/a.ts', mode: 'lines', lines: '2-3' }, blocks(stub('src/a.ts', 'lines')));
  check('lines 2-3', range && bodyOf(range).body === SOURCE.split('\n').slice(1, 3).join('\n'), JSON.stringify(range));
  const single = run(dir, { file: 'src/a.ts', mode: 'lines', lines: '4' }, blocks(stub('src/a.ts', 'lines')));
  check('lines 4', single && bodyOf(single).body === 'line4', JSON.stringify(single));
  const broken = run(dir, { file: 'src/a.ts', mode: 'lines', lines: '3-1' }, blocks(stub('src/a.ts', 'lines')));
  check('lines 3-1 — молчит', broken === null, JSON.stringify(broken));
}

// unchanged последним полем — запятая перед ним тоже уходит.
{
  const last = JSON.stringify({ file: 'src/a.ts', mode: 'full', unchanged: true });
  const out = run(dir, { file: 'src/a.ts' }, blocks(last));
  const body = out && bodyOf(out);
  check('unchanged последним полем', body?.body === SOURCE && !('unchanged' in body), JSON.stringify(out));
}

// Форма { content: [...] } возвращается той же формой.
{
  const out = run(dir, { file: 'src/a.ts' }, { content: blocks(stub('src/a.ts')) });
  check('форма {content} сохранена',
    Array.isArray(out?.updatedToolOutput?.content) && JSON.parse(out.updatedToolOutput.content[0].text).body === SOURCE,
    JSON.stringify(out));
}

// graph_root: путь считается от другого проекта; абсолютный путь — как есть.
{
  const other = project({ 'lib/b.ts': 'other\n' });
  const out = run(dir, { file: 'lib/b.ts', graph_root: other }, blocks(stub('lib/b.ts')));
  check('graph_root другого проекта', out && bodyOf(out).body === 'other\n', JSON.stringify(out));
  const abs = run(dir, { file: path.join(other, 'lib/b.ts') }, blocks(stub('lib/b.ts')));
  check('абсолютный путь', abs && bodyOf(abs).body === 'other\n', JSON.stringify(abs));
}

// Тишина: обычный ответ, map/signatures, чужая ветка, нет файла, нет индекса, строка вместо блоков.
{
  const fresh = JSON.stringify({ file: 'src/a.ts', mode: 'full', body: SOURCE });
  check('обычный ответ — молчит', run(dir, { file: 'src/a.ts' }, blocks(fresh)) === null);
  check('map — молчит', run(dir, { file: 'src/a.ts', mode: 'map' }, blocks(stub('src/a.ts', 'map'))) === null);
  check('graph_branch — молчит',
    run(dir, { file: 'src/a.ts', graph_root: dir, graph_branch: 'dev' }, blocks(stub('src/a.ts'))) === null);
  check('файла нет — молчит', run(dir, { file: 'src/gone.ts' }, blocks(stub('src/gone.ts'))) === null);
  check('ответ строкой — молчит', run(dir, { file: 'src/a.ts' }, stub('src/a.ts')) === null);

  const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'read-refill-bare-'));
  fs.mkdirSync(path.join(bare, 'src'));
  fs.writeFileSync(path.join(bare, 'src/a.ts'), SOURCE);
  check('без индекса относительный путь — молчит', run(bare, { file: 'src/a.ts' }, blocks(stub('src/a.ts'))) === null);
}

process.stdout.write(failed ? `\n=== ${failed} проверок упало ===\n` : '\n=== все проверки прошли ===\n');
process.exit(failed ? 1 : 0);
