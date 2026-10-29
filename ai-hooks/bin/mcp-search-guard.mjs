#!/usr/bin/env node
// Адаптер штатного поискового hook TokenSave к Codex; команды не исполняет.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const TIMEOUT_MS = 5000;
const MAX_OUTPUT_BYTES = 1024 * 1024;
const MCP_HINT = 'Используй MCP: tokensave_search/files для символов и путей; rag_search для поиска по смыслу, документации и конфигурации. Не повторяй поиск через другой shell или интерпретатор.';
const SEARCH_TOOLS = new Set(['Bash', 'Grep', 'Glob', 'Agent']);

function deny(reason) {
  console.log(JSON.stringify({ hookSpecificOutput: {
    hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason,
  } }));
}

function main() {
  let input;
  try { input = JSON.parse(fs.readFileSync(0, 'utf8')); }
  catch { deny(`Не удалось прочитать вход поискового hook. ${MCP_HINT}`); return; }
  if (!input || typeof input !== 'object') return;
  const name = String(input.tool_name || '').split('.').at(-1);
  const tool = ['exec_command', 'shell', 'shell_command'].includes(name) ? 'Bash'
    : name === 'spawn_agent' ? 'Agent' : name;
  if (!SEARCH_TOOLS.has(tool)) return;
  const args = input.tool_input && typeof input.tool_input === 'object' ? input.tool_input : {};
  const command = args.command ?? args.cmd ?? '';
  if (typeof command === 'string' && /\bTOKENSAVE_DISABLE_GREP_HOOK\s*=/.test(command)) {
    deny(`Отключение поискового hook запрещено. ${MCP_HINT}`); return;
  }
  const cwd = path.resolve(input.cwd || process.cwd(), typeof args.workdir === 'string' ? args.workdir : '.');
  const payload = { ...input, cwd, tool_name: tool, tool_input: { ...args, command } };
  const env = { ...process.env };
  delete env.TOKENSAVE_DISABLE_GREP_HOOK;
  const result = spawnSync(process.env.AI_HOOKS_TOKENSAVE_CMD || 'tokensave', ['hook-pre-tool-use'], {
    input: JSON.stringify(payload), encoding: 'utf8', cwd, env,
    timeout: TIMEOUT_MS, maxBuffer: MAX_OUTPUT_BYTES,
  });
  let decision;
  try { decision = JSON.parse(result.stdout || '{}'); } catch { decision = null; }
  if (result.error || result.status !== 0 || !decision) {
    // Сбой инструмента — явно обозначенный fallback, а не молчаливый запрет всех команд.
    console.log(JSON.stringify({ systemMessage: `Поисковый hook TokenSave недоступен; проверь tokensave и /hooks. ${MCP_HINT}` }));
    return;
  }
  const hook = decision.hookSpecificOutput;
  if (hook?.permissionDecision !== 'deny' && decision.permission !== 'deny') return;
  const reason = String(hook?.permissionDecisionReason || decision.agent_message || 'Поиск в обход MCP остановлен.')
    .replace(/\s*To override for this one call,[\s\S]*$/, '');
  deny(`${reason}\n${MCP_HINT}`);
}

main();
