#!/usr/bin/env node
// Делегирование задачи внешней модели через её CLI.
//
//   delegate.mjs [--provider glm|deepseek|codex|auto] [--mode fast|deep|jury]
//                [--out FILE] [--timeout SEC] "текст задачи"
//   delegate.mjs --health          — проверить провайдеров и обновить кэш
//   delegate.mjs --list            — что доступно сейчас
//
// Смысл: у внешних CLI отдельные квоты, и объёмная работа без контекста
// репозитория (черновик, boilerplate, разбор лога, второе мнение) дешевле
// уходит туда. Возвращается только текст ответа — вызывающий тратит токены
// на постановку задачи и чтение результата, а не на генерацию.
//
// Промпт уходит наружу, поэтому он проверяется на секреты и отклоняется до
// запуска: у стороннего провайдера нет причин видеть токен бота или DSN.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { findSecretValue } from '../security-core.mjs';
import { STATE_ROOT } from '../state-core.mjs';

const HOME = process.env.HOME || os.homedir();
const STATE_DIR = STATE_ROOT;
const HEALTH_FILE = path.join(STATE_DIR, 'cli-health.json');
// Успех кэшируем надолго, отказ — ненадолго. Отказ бывает плавающим: во время
// обновления CLI бинарь на секунды исчезает, и один такой промах, записанный
// на шесть часов, выключил бы рабочего провайдера до конца дня.
const OK_TTL_MS = 6 * 3600 * 1000;
const FAIL_TTL_MS = 10 * 60 * 1000;
// Нейтральный рабочий каталог: иначе opencode подтянет AGENTS.md и плагины
// проекта — лишние токены у провайдера и лишний контекст наружу.
const NEUTRAL_CWD = path.join(STATE_DIR, 'delegate-cwd');

// Провайдеры в порядке предпочтения. fast — короткий ответ, deep — рассуждение.
export const PROVIDERS = {
  deepseek: {
    label: 'DeepSeek',
    fast: 'deepseek/deepseek-v4-flash',
    deep: 'deepseek/deepseek-v4-pro',
    run: (model, prompt, timeout) => opencode(model, prompt, timeout),
  },
  glm: {
    label: 'GLM',
    fast: 'zai-coding-plan/glm-5.3-flash',
    deep: 'zai-coding-plan/glm-5.3',
    run: (model, prompt, timeout) => opencode(model, prompt, timeout),
  },
  codex: {
    label: 'Codex',
    // Не модель, а режим: Codex CLI переключает не имя модели, а глубину
    // рассуждения (config-ключ model_reasoning_effort), имя дефолтной модели
    // выбирает сам аккаунт и меняется вместе с ним — фиксировать его здесь
    // означало бы держать строку, которая устареет сама.
    fast: 'default',
    deep: 'high-effort',
    run: (tier, prompt, timeout) => codexExec(tier, prompt, timeout),
  },
};

const ANSI_RE = /\x1b\[[0-9;]*[A-Za-z]/g;

// Хуки и субагенты запускаются с урезанным окружением, где PATH может не
// содержать каталога nvm, поэтому бинарь ищем сами и запоминаем на процесс.
let opencodeBin = null;
function resolveOpencode() {
  if (opencodeBin) return opencodeBin;
  const candidates = [
    ...String(process.env.PATH || '').split(':').filter(Boolean).map((d) => path.join(d, 'opencode')),
    path.join(HOME, '.local', 'bin', 'opencode'),
    '/usr/local/bin/opencode',
  ];
  opencodeBin = candidates.find((c) => { try { fs.accessSync(c, fs.constants.X_OK); return true; } catch { return false; } })
    || 'opencode';
  return opencodeBin;
}

function opencode(model, prompt, timeoutSec) {
  fs.mkdirSync(NEUTRAL_CWD, { recursive: true });
  const out = execFileSync(resolveOpencode(),
    ['run', '--pure', '--dir', NEUTRAL_CWD, '-m', model, prompt],
    { encoding: 'utf8', timeout: timeoutSec * 1000, maxBuffer: 32 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
  return clean(out, model);
}

let codexBin = null;
function resolveCodex() {
  if (codexBin) return codexBin;
  const candidates = [
    ...String(process.env.PATH || '').split(':').filter(Boolean).map((d) => path.join(d, 'codex')),
    path.join(HOME, '.local', 'bin', 'codex'),
    '/usr/local/bin/codex',
  ];
  codexBin = candidates.find((c) => { try { fs.accessSync(c, fs.constants.X_OK); return true; } catch { return false; } })
    || 'codex';
  return codexBin;
}

// Codex не печатает чистый ответ на stdout (шапка сессии, эхо промпта, счётчик
// токенов) — `--output-last-message` пишет только финальный текст в файл, тот
// же приём, что `clean()` делает вручную для opencode. `--ephemeral` не
// оставляет сессию на диске: разовый вызов, история не нужна.
function codexExec(tier, prompt, timeoutSec) {
  fs.mkdirSync(NEUTRAL_CWD, { recursive: true });
  const outFile = path.join(STATE_DIR, `codex-last-${process.pid}-${Date.now()}.txt`);
  const args = ['exec', '--sandbox', 'read-only', '--skip-git-repo-check', '--ephemeral',
    '--color', 'never', '-C', NEUTRAL_CWD, '--output-last-message', outFile];
  if (tier === 'high-effort') args.push('-c', 'model_reasoning_effort=high');
  args.push(prompt);
  try {
    execFileSync(resolveCodex(), args, {
      encoding: 'utf8', timeout: timeoutSec * 1000, maxBuffer: 32 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return fs.readFileSync(outFile, 'utf8').trim();
  } finally {
    fs.rmSync(outFile, { force: true });
  }
}

// opencode печатает шапку «> build · model» и ANSI-раскраску — в ответе они шум.
function clean(text, model) {
  const short = String(model).split('/').pop();
  return String(text)
    .replace(ANSI_RE, '')
    .split('\n')
    .filter((l) => !new RegExp(`^\\s*>\\s*\\w+\\s*·\\s*${short}\\s*$`).test(l))
    .join('\n')
    .trim();
}

function readHealth() {
  try { return JSON.parse(fs.readFileSync(HEALTH_FILE, 'utf8')); } catch { return {}; }
}

function writeHealth(h) {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.writeFileSync(HEALTH_FILE, JSON.stringify(h, null, 2));
  } catch { /* без кэша просто будем проверять чаще */ }
}

export function probe(name) {
  const p = PROVIDERS[name];
  const started = Date.now();
  try {
    const answer = p.run(p.fast, 'Ответь ровно одним словом: работает', 90);
    const ok = answer.length > 0 && answer.length < 200;
    return { ok, ms: Date.now() - started, checked: new Date().toISOString(), error: ok ? null : 'пустой ответ' };
  } catch (e) {
    const msg = String(e.stderr || e.message || e).replace(ANSI_RE, '').split('\n').filter(Boolean).slice(-1)[0] || 'ошибка';
    return { ok: false, ms: Date.now() - started, checked: new Date().toISOString(), error: msg.slice(0, 200) };
  }
}

// Здоров ли провайдер. Свежий кэш — верим ему; протухший или отсутствующий —
// проверяем. Проверка стоит один короткий запрос, так что раз в 6 часов.
function healthy(name, { force = false } = {}) {
  const h = readHealth();
  const entry = h[name];
  const age = entry ? Date.now() - new Date(entry.checked).getTime() : Infinity;
  const fresh = entry && age < (entry.ok ? OK_TTL_MS : FAIL_TTL_MS);
  if (fresh && !force) return entry;
  const result = probe(name);
  h[name] = result;
  writeHealth(h);
  return result;
}

function order(preferred) {
  const all = Object.keys(PROVIDERS);
  if (preferred && preferred !== 'auto') return [preferred, ...all.filter((n) => n !== preferred)];
  return all;
}

export function delegate(prompt, { provider = 'auto', mode = 'fast', timeout = 240 } = {}) {
  const leak = findSecretValue(prompt);
  if (leak) {
    return { ok: false, provider: null, error: `в задаче найдено похожее на секрет («${leak}») — наружу не отправляю` };
  }

  const tier = mode === 'deep' ? 'deep' : 'fast';
  const errors = [];
  for (const name of order(provider)) {
    const health = healthy(name);
    if (!health.ok) { errors.push(`${PROVIDERS[name].label}: ${health.error}`); continue; }
    const started = Date.now();
    try {
      const answer = PROVIDERS[name].run(PROVIDERS[name][tier], prompt, timeout);
      if (!answer) { errors.push(`${PROVIDERS[name].label}: пустой ответ`); continue; }
      return { ok: true, provider: PROVIDERS[name].label, model: PROVIDERS[name][tier], ms: Date.now() - started, answer };
    } catch (e) {
      const msg = String(e.stderr || e.message || e).replace(ANSI_RE, '').split('\n').filter(Boolean).slice(-1)[0];
      errors.push(`${PROVIDERS[name].label}: ${String(msg).slice(0, 200)}`);
      writeHealth({ ...readHealth(), [name]: { ok: false, checked: new Date().toISOString(), error: String(msg).slice(0, 200) } });
    }
  }
  return { ok: false, provider: null, error: `ни один провайдер не ответил — ${errors.join('; ')}` };
}

// Жюри: одна задача двум провайдерам, ответы возвращаются рядом. Выбор
// лучшего — работа вызывающего: он один знает контекст задачи.
function jury(prompt, mode, timeout) {
  const out = [];
  for (const name of order('auto')) {
    const health = healthy(name);
    if (!health.ok) { out.push({ provider: PROVIDERS[name].label, ok: false, error: health.error }); continue; }
    const r = delegate(prompt, { provider: name, mode, timeout });
    out.push(r.ok
      ? { provider: r.provider, model: r.model, ms: r.ms, ok: true, answer: r.answer }
      : { provider: PROVIDERS[name].label, ok: false, error: r.error });
  }
  return out;
}

// --------------------------------------------------------------------------- CLI

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  const args = process.argv.slice(2);
  const flag = (n) => args.includes(n);
  const val = (n, d) => { const i = args.indexOf(n); return i !== -1 ? args[i + 1] : d; };

  if (flag('--health') || flag('--list')) {
    const force = flag('--health');
    const lines = [];
    for (const name of Object.keys(PROVIDERS)) {
      const h = healthy(name, { force });
      lines.push(`${PROVIDERS[name].label.padEnd(10)} ${h.ok ? 'работает' : 'НЕ РАБОТАЕТ'}  ${PROVIDERS[name].fast}` +
        (h.ok ? `  (${h.ms} мс)` : `  — ${h.error}`));
    }
    process.stdout.write(lines.join('\n') + '\n');
    process.exit(0);
  }

  const positional = args.filter((a, i) => !a.startsWith('--') && !String(args[i - 1] || '').startsWith('--'));
  const prompt = positional.join(' ').trim();
  if (!prompt) {
    process.stderr.write('нужен текст задачи. usage: delegate.mjs [--provider glm|deepseek|codex] [--mode fast|deep|jury] [--out FILE] "задача"\n');
    process.exit(2);
  }

  const mode = val('--mode', 'fast');
  const timeout = Number(val('--timeout', 240));
  const outFile = val('--out', null);

  if (mode === 'jury') {
    const results = jury(prompt, 'deep', timeout);
    const text = results.map((r) => r.ok
      ? `=== ${r.provider} (${r.model}, ${r.ms} мс) ===\n${r.answer}`
      : `=== ${r.provider}: не ответил — ${r.error} ===`).join('\n\n');
    if (outFile) { fs.writeFileSync(outFile, text + '\n'); process.stdout.write(`ответы записаны: ${outFile}\n`); }
    else process.stdout.write(text + '\n');
    process.exit(results.some((r) => r.ok) ? 0 : 1);
  }

  const r = delegate(prompt, { provider: val('--provider', 'auto'), mode, timeout });
  if (!r.ok) { process.stderr.write(`делегирование не удалось: ${r.error}\n`); process.exit(1); }
  if (outFile) {
    fs.writeFileSync(outFile, r.answer + '\n');
    process.stdout.write(`${r.provider} (${r.model}, ${r.ms} мс) → ${outFile}, ${r.answer.length} символов\n`);
  } else {
    process.stdout.write(`--- ${r.provider} (${r.model}, ${r.ms} мс) ---\n${r.answer}\n`);
  }
}
