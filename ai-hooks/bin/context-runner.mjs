#!/usr/bin/env node
// An app-server client that owns its threads. Never attaches to an existing UI.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { Accounting, acquireLease, atomicJson, readJson, hash, transition, ingestRollout, classify, redactDiagnostic } from './context-state.mjs';

const strings = ['ack', 'latestSteering', 'constraints', 'decisions', 'changedPaths', 'verification', 'unresolved', 'nextAction', 'result'];
export const checkpointSchema = {
  type: 'object', additionalProperties: false,
  properties: { status: { type: 'string', enum: ['running', 'completed', 'blocked'] },
    completedSteps: { type: 'integer', minimum: 0 },
    ...Object.fromEntries(strings.map(k => [k, { type: 'string' }])) },
  required: ['status', 'completedSteps', ...strings],
};

export function validateCheckpoint(value, ack) {
  if (!value || !['running', 'completed', 'blocked'].includes(value.status) ||
      !Number.isSafeInteger(value.completedSteps) || value.completedSteps < 0 ||
      strings.some(k => typeof value[k] !== 'string') || value.ack !== ack ||
      JSON.stringify(value).length > 3000 || (value.status === 'completed' && value.unresolved.trim())) {
    throw new Error('Invalid checkpoint/acknowledgement; no automatic replay');
  }
  return value;
}

export function chooseAction(state, policy) {
  if (state.checkpoint.status !== 'running') return state.checkpoint.status;
  if (state.checkpoint.unresolved.trim()) return 'blocked';
  if (state.turns >= policy.maxTurns || Date.now() - state.started >= policy.maxMs) return 'budget';
  if (!state.progress) return 'stalled';
  const usage = state.usage;
  const limit = usage.contextWindow ? usage.contextWindow * policy.contextRatio : policy.contextTokens;
  const high = usage.context >= limit || (usage.growth > 0 && usage.context + usage.growth >= limit * 1.1);
  if (!high || state.turns - state.lastMaintenance < policy.cooldownTurns) return 'continue';
  return state.compacted ? 'manual-handoff' : 'compact';
}

export function mcpEnvironmentOverrides(servers, env) {
  const overrides = [];
  for (const server of servers) {
    const transport = server.transport;
    if (server.enabled === false || transport?.type !== 'stdio' ||
        ![transport.command, ...(transport.args || [])].some(value => typeof value === 'string' && path.basename(value) === 'mcp-proxy.mjs')) continue;
    if (!/^[A-Za-z0-9_-]+$/.test(server.name)) throw new Error('Unsupported proxy server name for native config overrides');
    for (const key of ['HARNESS_CONTEXT_GENERATION_FILE', 'HARNESS_CONTEXT_OUTPUT_BUDGET_FILE']) {
      if (env[key]) overrides.push('-c', `mcp_servers.${server.name}.env.${key}=${JSON.stringify(env[key])}`);
    }
  }
  return overrides;
}

export class AppServer {
  constructor({ command = 'codex', args = ['app-server', '--stdio'], cwd, env = process.env, onEvent = () => {} }) {
    this.pending = new Map(); this.waiters = new Set(); this.backlog = []; this.id = 0; this.onEvent = onEvent;
    let overrides = [];
    if (command === 'codex' && env.HARNESS_CONTEXT_GENERATION_FILE) {
      const servers = JSON.parse(execFileSync(command, ['mcp', 'list', '--json'], { cwd, env, encoding: 'utf8', timeout: 10000, stdio: ['ignore', 'pipe', 'pipe'] }));
      overrides = mcpEnvironmentOverrides(servers, env);
    }
    // MCP clients may start servers with an environment allowlist. Explicit
    // process-local config overrides carry the generation/budget contract through
    // that boundary without editing user config or depending on env inheritance.
    this.child = spawn(command, [...args, ...overrides], { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
    this.child.on('error', error => this.fail(error));
    this.child.on('exit', () => this.fail(new Error('app-server transport closed; operation completion unknown')));
    this.child.stdin.on('error', error => this.fail(error));
    // Do not copy native diagnostics (potential credentials/tool content) into state.
    this.child.stderr.resume();
    const lines = createInterface({ input: this.child.stdout });
    lines.on('line', line => {
      let message;
      try { message = JSON.parse(line); } catch { this.fail(new Error('Invalid app-server JSON')); return; }
      if (message.id !== undefined && !message.method) {
        const pending = this.pending.get(message.id);
        if (pending) {
          this.pending.delete(message.id); clearTimeout(pending.timer);
          if (message.error) pending.reject(new Error(JSON.stringify(message.error))); else pending.resolve(message.result);
        }
        return;
      }
      if (message.id !== undefined) {
        // No unattended approval escalation or fabricated tool results.
        this.send({ id: message.id, error: { code: -32601, message: 'Interactive request unsupported by context runner' } });
        this.fail(new Error('Interactive request requires ordinary Codex UI'));
        return;
      }
      try { this.onEvent(message); } catch (error) { this.fail(error); return; }
      if (message.method === 'turn/completed' ||
          (message.method === 'item/completed' && message.params?.item?.type === 'contextCompaction')) {
        let matched = false;
        for (const waiter of this.waiters) if (waiter.predicate(message)) {
          this.waiters.delete(waiter); clearTimeout(waiter.timer); waiter.resolve(message); matched = true;
        }
        if (!matched) { this.backlog.push(message); if (this.backlog.length > 32) this.backlog.shift(); }
      }
    });
  }
  send(message) { this.child.stdin.write(`${JSON.stringify(message)}\n`); }
  request(method, params, timeout = 120000) {
    if (this.failure) return Promise.reject(this.failure);
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id); reject(new Error(`${method} timeout; completion unknown`));
      }, timeout);
      this.pending.set(id, { resolve, reject, timer }); this.send({ id, method, params });
    });
  }
  wait(predicate, timeout = 600000) {
    if (this.failure) return Promise.reject(this.failure);
    const at = this.backlog.findIndex(predicate);
    if (at >= 0) return Promise.resolve(this.backlog.splice(at, 1)[0]);
    return new Promise((resolve, reject) => {
      const waiter = { predicate, resolve, reject, timer: setTimeout(() => {
        this.waiters.delete(waiter); reject(new Error('Native completion timeout; no replay'));
      }, timeout) };
      this.waiters.add(waiter);
    });
  }
  fail(error) {
    this.failure = error;
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(error); }
    this.pending.clear();
    for (const w of this.waiters) { clearTimeout(w.timer); w.reject(error); }
    this.waiters.clear();
  }
  close() { this.child.stdin.end(); this.child.kill('SIGTERM'); this.fail(new Error('Client closed')); }
  async initialize(timeout) {
    const result = await this.request('initialize', { clientInfo: { name: 'harness_context', version: '1.0.0' } }, timeout);
    this.send({ method: 'initialized' }); return result;
  }
}

export const defaultPolicy = { contextRatio: 0.75, contextTokens: 120000, cooldownTurns: 2,
  maxTurns: 12, maxMs: 30 * 60 * 1000 };

export function policyFor(overrides = {}) {
  if (Object.keys(overrides).some(k => !Object.hasOwn(defaultPolicy, k))) throw new Error('Unknown context policy setting');
  const policy = { ...defaultPolicy, ...overrides };
  for (const [k, value] of Object.entries(policy)) {
    if (!Number.isFinite(value) || (k !== 'contextRatio' && (!Number.isSafeInteger(value) || value < 1))) throw new Error(`Invalid policy: ${k}`);
  }
  if (policy.contextRatio < 0.25 || policy.contextRatio > 0.95) throw new Error('Invalid context policy limits');
  return policy;
}

export async function runObjective({ project, objective, permissions, dir, policy = defaultPolicy, clientFactory = options => new AppServer(options) }) {
  policy = policyFor(policy);
  const release = acquireLease(dir);
  let previous;
  try { previous = readJson(path.join(dir, 'state.json'), null); }
  catch (error) { release(); throw error; }
  if (previous && !['completed', 'blocked', 'budget', 'stalled', 'manual-handoff'].includes(previous.phase)) {
    release(); throw new Error('Unfinished prior run; inspect checkpoint and unresolved operations before recovery');
  }
  const task = crypto.randomUUID();
  const accounting = new Accounting();
  let state = { v: 1, task, project, objective, permissions, started: Date.now(), phase: 'starting',
    turns: 0, generation: 0, lastMaintenance: -policy.cooldownTurns, compacted: false, threads: [], usage: accounting.state };
  let active = new Set(); let finalText = ''; let client; let stopped = false;
  const generationFile = path.join(dir, 'generation.json');
  const outputBudgetFile = path.join(dir, 'output-budget.log');
  const persist = () => atomicJson(path.join(dir, 'state.json'), state);
  const remaining = () => Math.max(1, policy.maxMs - (Date.now() - state.started));
  const invalidate = () => { accounting.invalidate(); atomicJson(generationFile, { v: 1, task, generation: ++state.generation }); };
  const emit = phase => { state.phase = phase; persist(); transition(dir, phase, { task, thread: state.thread, turns: state.turns }); console.log(`context: ${phase}; state=${path.join(dir, 'state.json')}`); };
  const stop = () => { stopped = true; client?.close(); };
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  try {
    invalidate(); persist();
    client = clientFactory({ cwd: project, env: { ...process.env, HARNESS_CONTEXT_GENERATION_FILE: generationFile, HARNESS_CONTEXT_OUTPUT_BUDGET_FILE: outputBudgetFile },
      onEvent(event) {
        accounting.event(event);
        const p = event.params;
        if (p?.threadId === state.thread && ['model/rerouted', 'thread/compacted'].includes(event.method)) invalidate();
        if (event.method === 'item/started' && p?.threadId === state.thread) active.add(p.item.id);
        if (event.method === 'item/completed' && p?.threadId === state.thread) {
          active.delete(p.item.id);
          if (p.item.type === 'contextCompaction') { invalidate(); state.compacted = true; }
          if (p.item.type === 'agentMessage' && (!p.item.phase || p.item.phase === 'final_answer')) finalText = p.item.text;
          const text = p.item.aggregatedOutput;
          if (typeof text === 'string') accounting.state.outputBytes += Buffer.byteLength(text);
        }
      } });
    await client.initialize(remaining());
    const thread = await client.request('thread/start', { cwd: project }, remaining());
    if (!thread.thread?.id) throw new Error('Missing new thread id');
    state.thread = thread.thread.id; state.threads.push(state.thread); invalidate();
    emit('thread-started');
    const ack = crypto.randomUUID();
    while (!stopped) {
      if (Date.now() - state.started >= policy.maxMs) { emit('budget'); break; }
      const prompt = state.turns === 0 ? `Start this authorized objective. Read project instructions.\nObjective: ${objective}\nUser permissions and constraints (never expand them): ${permissions}\n` : 'Continue from the last checkpoint and latest user steering.\n';
      const instructions = `Work autonomously for one useful, bounded step, then return the checkpoint JSON (<=3000 characters). No subagents. Never push unless explicitly permitted. Stop all tools/tests before returning. Preserve user changes. Do not replay uncertain writes. status=completed only after objective and verification are actually finished; blocked for missing user input. unresolved lists pending/uncertain operations (empty if none). completedSteps must increase only after useful progress. Include input-specific verification, changed paths, decisions, latest steering and the next action. Keep secrets out of the checkpoint. ack must equal ${ack}.`;
      finalText = ''; emit('turn-pending');
      fs.writeFileSync(outputBudgetFile, '', { mode: 0o600 });
      const result = await client.request('turn/start', { threadId: state.thread,
        input: [{ type: 'text', text: prompt + instructions }], outputSchema: checkpointSchema }, remaining());
      const completed = await client.wait(e => e.method === 'turn/completed' && e.params.threadId === state.thread && e.params.turn.id === result.turn.id,
        Math.max(1, policy.maxMs - (Date.now() - state.started)));
      if (completed.params.turn.status !== 'completed' || active.size) throw new Error('Turn not safely completed; inspect native thread');
      const checkpoint = validateCheckpoint(JSON.parse(finalText), ack);
      state.progress = checkpoint.completedSteps > (state.checkpoint?.completedSteps ?? 0);
      state.checkpoint = checkpoint; state.turns++;
      atomicJson(path.join(dir, 'checkpoint.json'), { v: 1, task, project, objective, permissions, thread: state.thread, checkpoint });
      emit('checkpoint');
      const action = chooseAction(state, policy);
      if (['completed', 'blocked', 'budget', 'stalled', 'manual-handoff'].includes(action)) { emit(action); break; }
      if (action === 'compact') {
        emit('compaction-pending');
        await client.request('thread/compact/start', { threadId: state.thread }, remaining());
        await client.wait(e => e.method === 'item/completed' && e.params.threadId === state.thread && e.params.item.type === 'contextCompaction', remaining());
        state.compacted = true; state.lastMaintenance = state.turns; emit('compacted');
      }
    }
    if (state.phase === 'completed') {
      fs.rmSync(generationFile, { force: true });
      fs.rmSync(outputBudgetFile, { force: true });
      console.log(state.checkpoint.result);
    }
    if (state.phase === 'manual-handoff') {
      console.log(`Continue manually in Codex using ${path.join(dir, 'checkpoint.json')}; no new thread was started.`);
    }
    return state;
  } catch (error) {
    state.errorClass = classify(error, state.phase === 'turn-pending'); emit('recovery-required');
    throw error;
  } finally {
    process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop);
    client?.close(); release();
  }
}

export function stateDirectory(project) {
  const base = process.env.XDG_STATE_HOME || path.join(os.homedir(), '.local/state');
  const dir = path.join(base, 'harness/context', hash(fs.realpathSync(project)).slice(0, 24));
  if (dir === project || dir.startsWith(`${project}${path.sep}`)) throw new Error('Context state must be outside the indexed project');
  return dir;
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (!['run', 'status', 'observe', 'recover'].includes(command)) {
    console.log('harness-context run PROJECT OBJECTIVE_FILE PERMISSIONS_FILE [POLICY_JSON]\nharness-context status PROJECT\nharness-context observe PROJECT ROLLOUT_JSONL\nharness-context recover PROJECT (manual audit required; never replays work)');
    process.exitCode = command ? 2 : 0; return;
  }
  const project = fs.realpathSync(args[0]); const dir = stateDirectory(project);
  if (command === 'status') { console.log(JSON.stringify(readJson(path.join(dir, 'state.json'), { phase: 'absent' }), null, 2)); return; }
  if (command === 'recover') {
    const lease = readJson(path.join(dir, 'lease.json'), null);
    if (lease) {
      try { process.kill(lease.pid, 0); throw new Error('Lease owner still alive'); }
      catch (error) { if (error.code !== 'ESRCH') throw error; }
    }
    // Explicit invocation asserts the user has inspected child processes and writes.
    fs.rmSync(path.join(dir, 'lease.json'), { force: true });
    const release = acquireLease(dir);
    try {
      const state = readJson(path.join(dir, 'state.json'), {});
      atomicJson(path.join(dir, 'state.json'), { ...state, phase: 'blocked', recovery: 'Manual audit; old objective is not restarted' });
      transition(dir, 'manual-recovery');
    } finally { release(); }
    return;
  }
  if (command === 'observe') {
    const release = acquireLease(dir);
    try {
      const file = fs.realpathSync(args[1]); const stateFile = path.join(dir, `rollout-${hash(file).slice(0, 16)}.json`);
      const previous = readJson(stateFile, {}); const accounting = new Accounting(previous.usage);
      const cursor = ingestRollout(file, previous.cursor || {}, accounting);
      atomicJson(stateFile, { v: 1, cursor, usage: accounting.state });
      console.log(JSON.stringify({ cursor, usage: accounting.state }));
    } finally { release(); }
    return;
  }
  const objective = fs.readFileSync(args[1], 'utf8'); const permissions = fs.readFileSync(args[2], 'utf8');
  if (!objective.trim() || !permissions.trim() || objective.length + permissions.length > 16000) throw new Error('Objective and explicit permissions must be nonempty and <=16000 characters combined');
  const policy = policyFor(args[3] ? readJson(args[3], {}) : {});
  const state = await runObjective({ project, objective, permissions, dir, policy });
  if (state.phase !== 'completed') process.exitCode = 1;
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(`context: ${classify(error)}; ${redactDiagnostic(error.message)}`); process.exitCode = 1; });
}
