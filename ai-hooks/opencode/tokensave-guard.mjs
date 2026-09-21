// OpenCode-плагин: те же гарды tokensave, что и в Claude Code.
// Единая точка истины логики — ../guard-core.mjs.
//
// Соответствие хуков:
//   Claude PreToolUse(Read|Grep|Edit|Write) → tool.execute.before (throw = deny)
//   Claude UserPromptSubmit (branch)        → chat.message
//   Claude Stop (sync)                      → event: session.idle
//
// Гарды tokensave срабатывают ТОЛЬКО для файлов, которые есть в индексе.
// Перед ними — гард безопасности (../security-core.mjs), общий с Claude Code.

import { execFile } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  guardRead, guardGrep, guardEdit, guardBash, OPENCODE_LABELS,
} from '../guard-core.mjs';
import { securityGuard, DENY } from '../security-core.mjs';

// Каталог bin рядом с этим файлом (../bin), а не зашитый абсолютный путь с
// именем пользователя — плагин ставится в чужой $HOME.
const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin');

// Скрипты сами уходят в фон (setsid) и берут лок — ждать их не нужно.
// Ошибки игнорируем: индексация не должна ломать сессию.
function runDetached(script, directory) {
  execFile('bash', [`${BIN}/${script}`, directory], () => {});
}

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

      let reason = null;

      switch (input.tool) {
        case 'read':
          reason = guardRead(args.filePath, directory, OPENCODE_LABELS);
          break;
        case 'grep':
          // include — glob-маска opencode-инструмента grep.
          reason = guardGrep(
            { path: args.path, glob: args.include },
            directory,
            OPENCODE_LABELS,
          );
          break;
        case 'edit':
        case 'write':
          reason = guardEdit(args.filePath, directory, OPENCODE_LABELS);
          break;
        case 'bash':
          // Shell выражает те же действия, что read/grep/edit, — гард тот же.
          reason = guardBash(args.command, directory, OPENCODE_LABELS);
          break;
      }

      // throw в tool.execute.before блокирует вызов; текст уходит в модель
      // как результат инструмента — это аналог permissionDecisionReason.
      if (reason) throw new Error(reason);
    },

    'chat.message': async () => {
      runDetached('tokensave-branch.sh', directory);
      runDetached('ragsave-sync.sh', directory);
    },

    event: async ({ event }) => {
      if (event.type !== 'session.idle') return;
      runDetached('tokensave-sync.sh', directory);
      runDetached('ragsave-sync.sh', directory);
    },
  };
};
