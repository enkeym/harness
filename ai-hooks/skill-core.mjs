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
import os from 'node:os';
import path from 'node:path';
import { statePath, readJSON, writeJSON } from './state-core.mjs';
import { segments, tokenize, commandIndex, commandName, baseCommand, gitSubcommandAt, copyOperands, makesCommit } from './shell-core.mjs';

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
// Файл из индекса tokensave правят его инструментами: Read на нём режет
// read-router, а Edit без Read не работает. Путь у них бывает относительным от
// корня проекта. replace_symbol и insert_at_symbol пути не несут, а символов у
// файлов инструкций нет.
export const MCP_EDIT_RE = /tokensave_(str_replace|multi_str_replace|replace_lines|insert_at)$/;

function editedFile(toolName, toolInput, cwd) {
  if (EDIT_TOOLS.has(toolName)) return toolInput?.file_path || toolInput?.notebook_path;
  if (MCP_EDIT_RE.test(toolName) && toolInput?.path) return path.resolve(cwd || process.cwd(), String(toolInput.path));
  return null;
}

export const GATES = [
  {
    id: 'instructions',
    requires: ['skill-authoring'],
    what: 'правка файла инструкций (SKILL.md, reference/, commands/*.md, CLAUDE.md)',
    matches: (toolName, toolInput, cwd) => isInstructionFile(editedFile(toolName, toolInput, cwd))
      || (toolName === 'Bash' && bashWrites(toolInput?.command, cwd).some(isInstructionFile)),
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

// Запись файла через shell: назначение cp/mv/ln/rsync/install (в каталог —
// каталог/имя источника), цель `>`/`>>`, файлы tee, sed/perl -i, пути git
// checkout/restore. Копия *из* файла — чтение, его судит bash-router. Существующий
// файл bash-router переписать и так не даст, а новый SKILL.md и откат через git — даст.
const COPY_CMDS = new Set(['cp', 'mv', 'ln', 'rsync', 'install']);
const INPLACE_CMDS = new Set(['sed', 'perl']);

export function bashWrites(command, cwd) {
  if (!command) return [];
  const out = [];
  try {
    for (const { text } of segments(command)) {
      const toks = tokenize(text);
      const at = commandIndex(toks);
      const cmd = baseCommand(commandName(toks));
      toks.forEach((t, i) => {
        const m = t.match(/^(?:\d*|&)>>?(.*)$/);
        if (m && !m[1].startsWith('&')) out.push(m[1] || toks[i + 1]);
      });
      const sub = cmd === 'git' ? gitSubcommandAt(toks) : -1;
      if (COPY_CMDS.has(cmd)) {
        const { sources, target } = copyOperands(toks);
        if (target) out.push(target, ...sources.map((s) => path.join(target, path.basename(s))));
      } else if (cmd === 'tee' || (INPLACE_CMDS.has(cmd) && toks.some((t) => /^-[a-zA-Z]*i|^--in-place/.test(t)))) {
        out.push(...toks.slice(at + 1));
      } else if (sub !== -1 && ['checkout', 'restore'].includes(toks[sub])) {
        out.push(...toks.slice(sub + 1));
      }
    }
  } catch {
    return [];
  }
  const home = os.homedir();
  return out.filter(Boolean).map((p) =>
    path.resolve(cwd || process.cwd(), p.replace(/^(~|\$HOME|\$\{HOME\})(?=\/|$)/, home)));
}

// Любой сегмент команды — `git … commit` или другая подкоманда из makesCommit. Пайп
// не исключение: `… | git commit -F -` коммитит так же. Разбор — общий shell-core, как у
// security-guard: обёртки (`sudo`, `env X=1`), фоновый `&` и `$(…)` своя копия пропускала.
export function isGitCommit(command) {
  if (!command) return false;
  try {
    return segments(command).some(({ text }) => {
      const all = tokenize(text);
      // Срез от настоящей команды: `sudo -u git git commit` — git здесь второй.
      const toks = all.slice(commandIndex(all));
      return commandName(toks) === 'git' && makesCommit(toks, gitSubcommandAt(toks));
    });
  } catch {
    return false;
  }
}

// Сообщение коммита без пустой строки после заголовка: git склеивает заголовок
// с пунктами в одну строку `%s`. Замечено уже после push, такое чинят amend и
// force push — дважды переписанная ветка вместо одного коммита. Поэтому сообщение
// проверяется до коммита. Источники: `-F -` с heredoc, первый `-m`, в том числе
// `-m "$(cat <<'EOF' … EOF)"`. `printf … | git commit -F -` не разбирается.
const HEREDOC_RE = /<<-?\s*(?:'(\w+)'|"(\w+)"|\\?(\w+))/;
const CAT_HEREDOC_RE = /^\$\(\s*cat\s+<<-?\s*['"]?(\w+)['"]?\s*\n([\s\S]*?)\n\s*\1\s*\)$/;

function commitMessage(text) {
  const [head, ...body] = text.split('\n');
  const toks = tokenize(head);
  const from = gitSubcommandAt(toks) + 1;
  const stdin = toks.slice(from).some((t, k, a) =>
    t === '-F-' || t === '--file=-' || ((t === '-F' || t === '--file') && a[k + 1] === '-'));
  const doc = head.match(HEREDOC_RE);
  if (stdin && doc) {
    const term = doc[1] ?? doc[2] ?? doc[3];
    if (body.length && body[body.length - 1].trim() === term) body.pop();
    return body.join('\n');
  }
  const all = tokenize(text);
  const k = all.findIndex((t, j) => j >= from && (t === '-m' || t === '--message'));
  const raw = k === -1
    ? all.find((t, j) => j >= from && /^(-m|--message=)./.test(t))?.replace(/^(-m|--message=)/, '')
    : all[k + 1];
  if (raw == null) return null;
  return raw.match(CAT_HEREDOC_RE)?.[2] ?? raw;
}

// Текст запрета либо null.
export function commitMessageProblem(command) {
  if (!command) return null;
  try {
    for (const { text } of segments(command, { keepHeredoc: true })) {
      if (!isGitCommit(text.split('\n')[0])) continue;
      const msg = commitMessage(text);
      if (msg == null) continue;
      const lines = msg.replace(/^\s*\n/, '').split('\n');
      if (lines.length > 1 && lines[1].trim() !== '') {
        return (
          `В сообщении коммита нет пустой строки после заголовка «${lines[0].trim().slice(0, 80)}»: ` +
          'git склеит заголовок с телом в одну строку. Вставь пустую строку второй строкой и повтори git commit.'
        );
      }
    }
  } catch { /* разбор не должен мешать коммиту */ }
  return null;
}

// Выключатели: переменная — для тестов чужих хуков; файл — «отключить, не
// трогая конфиг».
export function gateEnabled() {
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
export function missingSkills(toolName, toolInput, loaded, cwd) {
  for (const gate of GATES) {
    if (!gate.matches(toolName, toolInput, cwd)) continue;
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
