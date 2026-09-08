#!/usr/bin/env node
// Claude Code, SessionStart: новая сессия начинается с режима по умолчанию.
//
// Решение каталога (/ask, /ask-off) живёт до конца сессии — как встроенные
// режимы, а не как настройка проекта. Сбрасываем только на старте и на /clear;
// на resume и compact сессия продолжается, режим менять нельзя.
//
// Дедуп по session_id: harness присылает SessionStart с source "startup" не
// только при первом запуске, но и повторно в той же сессии (compact,
// восстановление контекста). Без дедупа второй такой вызов сбрасывал режим
// прямо посреди работы — /ask, включённый в начале сессии, молча слетал.
// Первый SessionStart любого рода закрепляет session_id за собой; сбрасывает
// только он и только при startup/clear.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { resetMode } from '../ask-core.mjs';

const SEEN_FILE = path.join(os.homedir(), '.claude', 'state', 'ask-mode', '.sessions.json');
const SEEN_TTL_MS = 2 * 86400 * 1000;

// Помечает session_id как виденный, возвращает, был ли он там раньше.
// Нет session_id → дедупить нечем, ведём себя как раньше (не «виден»).
function markSeen(sessionId) {
  if (!sessionId) return false;
  const now = Date.now();
  let seen = {};
  try {
    const parsed = JSON.parse(fs.readFileSync(SEEN_FILE, 'utf8'));
    if (parsed && typeof parsed === 'object') seen = parsed;
  } catch { /* первого старта ещё не было */ }

  for (const [id, ts] of Object.entries(seen)) {
    if (typeof ts !== 'number' || now - ts > SEEN_TTL_MS) delete seen[id];
  }

  const was = Object.prototype.hasOwnProperty.call(seen, sessionId);
  seen[sessionId] = now;

  try {
    fs.mkdirSync(path.dirname(SEEN_FILE), { recursive: true });
    fs.writeFileSync(SEEN_FILE, JSON.stringify(seen));
  } catch { /* не записали — в худшем случае сбросим ещё раз */ }

  return was;
}

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => { raw += c; });
process.stdin.on('end', () => {
  let input;
  try { input = JSON.parse(raw); } catch { process.exit(0); }
  const firstTime = !markSeen(input.session_id);
  const fresh = input.source === 'startup' || input.source === 'clear';
  if (firstTime && fresh) {
    try { resetMode(input.cwd); } catch { /* не сбросили — режим просто останется прежним */ }
  }
  process.exit(0);
});
