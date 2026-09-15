// Гейт скиллов. CLAUDE.md велит грузить скилл до первого действия в его
// области, но это правило модель забывает чаще прочих: правит SKILL.md по
// памяти, коммитит без ревью. Здесь то же правило становится хуком — для двух
// областей, где цена забывания видна сразу: файлы инструкций (skill-authoring)
// и git commit (review-standards, review-security, git-flow — без последнего
// в сообщение попадает Co-Authored-By, а это политика компании).
//
// Модуль чистый: не читает stdin, не пишет stdout. Метка «загружен» ставится
// на PreToolUse инструмента Skill и на промпт вида `/name` (пользовательский
// вызов через Skill не проходит) и живёт по session_id: /clear даёт новую
// сессию, и скилл в ней снова не загружен — как и в контексте модели.

import fs from 'node:fs';
import { statePath, readJSON, writeJSON } from './state-core.mjs';
import { segments, tokenize, commandName } from './guard-core.mjs';
import { insideDoctor } from './hooklog-core.mjs';

const STATE_FILE = statePath('skills-loaded.json');
// Сессия с --resume живёт днями; неделя покрывает её, а файл не растёт вечно.
const KEEP_MS = 7 * 24 * 60 * 60 * 1000;

// Файлы, которые правят только со скиллом skill-authoring: SKILL.md и его
// reference/, командные файлы, агенты OpenCode, общие правила, любой CLAUDE.md
// или AGENTS.md. Скиллы и команды — только под .claude/, .opencode/,
// ~/.config/opencode/ или в харнесе: `src/commands/x.md` в проекте не файл
// инструкций.
const INSTRUCTION_FILE_RE =
  /(^|[\\/])(\.claude|claude|harness|opencode|\.opencode)[\\/](skills[\\/][^\\/]+[\\/](SKILL\.md|reference[\\/][^\\/]+\.md)|commands[\\/][^\\/]+\.md|agents?[\\/][^\\/]+\.md|rules[\\/][^\\/]+\.md)$/;
const CLAUDE_MD_RE = /(^|[\\/])(CLAUDE|AGENTS)\.md$/;

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

// Глобальные опции git, которые берут значение отдельным токеном: `git -C dir
// commit` — подкоманда третья, а не вторая.
const GIT_OPTS_WITH_VALUE = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace']);

export const GATES = [
  {
    id: 'instructions',
    requires: ['skill-authoring'],
    what: 'правка файла инструкций (SKILL.md, reference/, commands/*.md, CLAUDE.md)',
    matches: (toolName, toolInput) =>
      EDIT_TOOLS.has(toolName) && isInstructionFile(toolInput?.file_path || toolInput?.notebook_path),
  },
  {
    id: 'commit',
    requires: ['review-standards', 'review-security', 'git-flow'],
    what: 'git commit',
    matches: (toolName, toolInput) => toolName === 'Bash' && isGitCommit(toolInput?.command),
  },
];

export function isInstructionFile(p) {
  const s = String(p || '');
  return INSTRUCTION_FILE_RE.test(s) || CLAUDE_MD_RE.test(s);
}

function gitSubcommand(toks) {
  let i = 1;
  while (i < toks.length && toks[i].startsWith('-')) {
    i += GIT_OPTS_WITH_VALUE.has(toks[i]) ? 2 : 1;
  }
  return toks[i] || null;
}

// Любой сегмент команды — `git … commit`. Пайп не исключение: `… | git commit
// -F -` коммитит так же.
export function isGitCommit(command) {
  if (!command) return false;
  try {
    return segments(command).some(({ text }) => {
      const toks = tokenize(text);
      return commandName(toks) === 'git' && gitSubcommand(toks) === 'commit';
    });
  } catch {
    return false;
  }
}

// Выключатели: внутри доктора правки и коммиты запрещены и так; переменная —
// для тестов чужих хуков; файл — «отключить, не трогая конфиг».
export function gateEnabled() {
  if (insideDoctor()) return false;
  if (process.env.AI_HOOKS_SKILL_GATE_OFF === '1') return false;
  return !fs.existsSync(statePath('skill-gate.off'));
}

function prune(state, now) {
  for (const [sid, entry] of Object.entries(state)) {
    if (!entry || typeof entry.t !== 'number' || now - entry.t > KEEP_MS) delete state[sid];
  }
  return state;
}

// `plugin:skill` и `apps/web:deploy` — имя скилла после последнего двоеточия.
export function skillName(raw) {
  const s = String(raw || '').trim();
  return s.includes(':') ? s.slice(s.lastIndexOf(':') + 1) : s;
}

export function markLoaded(sessionId, skill) {
  const name = skillName(skill);
  if (!sessionId || !name) return false;
  const now = Date.now();
  const state = prune(readJSON(STATE_FILE, {}), now);
  const entry = state[sessionId] || { t: now, skills: {} };
  entry.t = now;
  entry.skills = { ...(entry.skills || {}), [name]: now };
  state[sessionId] = entry;
  return writeJSON(STATE_FILE, state);
}

export function loadedSkills(sessionId) {
  const entry = readJSON(STATE_FILE, {})[sessionId];
  return new Set(Object.keys(entry?.skills || {}));
}

// Гейт, который не пройден: { id, what, missing } либо null.
export function missingSkills(toolName, toolInput, loaded) {
  for (const gate of GATES) {
    if (!gate.matches(toolName, toolInput)) continue;
    const missing = gate.requires.filter((s) => !loaded.has(s));
    if (missing.length) return { id: gate.id, what: gate.what, missing };
  }
  return null;
}

// Текст запрета: что требуется и как это получить. Выключатель здесь не
// называется намеренно — запрет должен вести к скиллу, а не в обход.
export function denyReason(gap) {
  const load = gap.missing.map((s) => `Skill(${s})`).join(', ');
  if (gap.id === 'commit') {
    return (
      `Коммит без ревью: в этой сессии не загружены ${gap.missing.join(', ')}. ` +
      `Загрузи ${load}, прогони дифф по чек-листам, затем повтори git commit.`
    );
  }
  return (
    `${gap.what[0].toUpperCase()}${gap.what.slice(1)} требует скилла ${gap.missing.join(', ')} — ` +
    `в этой сессии он не загружен. Загрузи ${load} и повтори правку.`
  );
}
