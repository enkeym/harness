// OpenCode-плагин: те же гарды, что и в Claude Code, — безопасность
// (../security-core.mjs) и shell-гард (../guard-core.mjs).
//
// Соответствие хуков:
//   Claude PreToolUse(Bash)                 → tool.execute.before (throw = deny)
//   Claude SessionStart (ragsave-sync.sh)   → event: session.created
//   Claude Stop (ragsave-sync.sh)           → event: session.idle

import { execFile } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { guardBash, guardRead, OPENCODE_LABELS } from '../guard-core.mjs';
import { securityGuard, DENY } from '../security-core.mjs';

// Каталог bin рядом с этим файлом (../bin), а не зашитый абсолютный путь с
// именем пользователя — плагин ставится в чужой $HOME.
const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin');

// Скрипты сами уходят в фон (setsid) и берут лок — ждать их не нужно.
// Ошибки игнорируем: индексация не должна ломать сессию.
function runDetached(script, directory) {
  execFile('bash', [`${BIN}/${script}`, directory], () => {});
}

// События, после которых индекс догоняет файлы: начало сессии — правки между
// сессиями, конец хода — правки хода.
const SYNC_EVENTS = new Set(['session.created', 'session.idle']);

// Файлы из patchText инструмента patch: Add/Update/Delete File и Move to.
const PATCH_FILE_RE = /^\*\*\* (?:(?:Add|Update|Delete) File|Move to): (.+)$/gm;

// Инструмент OpenCode → вызовы в терминах Claude, которые понимает ядро.
// Остальные (MCP: `tokensave_tokensave_read`, `tokensave_tokensave_body`)
// идут как `mcp__opencode__<имя>`: ядро узнаёт читающие по имени и проверяет
// путь в аргументах — иначе .env отдал бы индекс tokensave.
const SECURITY_CALLS = {
  read: (args) => [['Read', { file_path: args.filePath }]],
  grep: (args) => [['Grep', { path: args.path, glob: args.include }]],
  edit: (args) => [['Edit', { file_path: args.filePath }]],
  write: (args) => [['Edit', { file_path: args.filePath }]],
  multiedit: (args) => [['Edit', { file_path: args.filePath }]],
  patch: (args) => [...String(args.patchText ?? '').matchAll(PATCH_FILE_RE)]
    .map((m) => ['Edit', { file_path: m[1].trim() }]),
  bash: (args) => [['Bash', { command: args.command }]],
};

// Блокируется только DENY (секреты). ASK здесь не спросить — его закрывает
// permission.bash в конфиге OpenCode. Ошибка самого гарда вызов не блокирует:
// fail-open, как в адаптере Claude.
function securityReason(tool, args, directory) {
  const calls = SECURITY_CALLS[tool] ?? ((a) => [[`mcp__opencode__${tool}`, a]]);
  try {
    for (const [toolName, toolInput] of calls(args)) {
      const verdict = securityGuard(toolName, toolInput, { cwd: directory });
      if (verdict?.level === DENY) return `security-guard, запрет: ${verdict.reason}`;
    }
    return null;
  } catch {
    return null;
  }
}

export const TokensaveGuard = async ({ directory }) => {
  return {
    'tool.execute.before': async (input, output) => {
      const args = output.args ?? {};
      const security = securityReason(input.tool, args, directory);
      if (security) throw new Error(security);

      // throw в tool.execute.before блокирует вызов; текст уходит в модель
      // как результат инструмента — это аналог permissionDecisionReason.
      if (input.tool === 'bash') {
        const reason = guardBash(args.command, directory, OPENCODE_LABELS);
        if (reason) throw new Error(reason);
      }
      if (input.tool === 'read') {
        const reason = guardRead(args.filePath, directory, OPENCODE_LABELS, input.sessionID);
        if (reason) throw new Error(reason);
      }
    },

    event: async ({ event }) => {
      if (!SYNC_EVENTS.has(event.type)) return;
      runDetached('ragsave-sync.sh', directory);
    },
  };
};
