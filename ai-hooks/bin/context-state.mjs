// Private, versioned context accounting. No provider pricing assumptions.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const hash = (value) => crypto.createHash('sha256').update(value).digest('hex');
export function redactDiagnostic(value) {
  return String(value)
    .replace(/\bBearer\s+[^\s"']+/gi, 'Bearer [redacted]')
    .replace(/\b(api[_-]?key|password|secret|access[_-]?token)\b(["']?\s*[:=]\s*["']?)[^\s,"'}]+/gi, '$1$2[redacted]')
    .replace(/\b(?:sk-|ghp_|xox[baprs]-)[A-Za-z0-9_-]{12,}/g, '[redacted]');
}
export function atomicJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  const fd = fs.openSync(temp, 'wx', 0o600);
  try { fs.writeFileSync(fd, `${JSON.stringify(value)}\n`); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
  fs.renameSync(temp, file);
}

export function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return fallback; throw error; }
}

export function acquireLease(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, 'lease.json');
  const owner = { pid: process.pid, nonce: crypto.randomUUID(), started: Date.now() };
  // Stale leases are deliberately not stolen. A dead parent may have live tools.
  const fd = fs.openSync(file, 'wx', 0o600);
  fs.writeFileSync(fd, JSON.stringify(owner)); fs.fsyncSync(fd); fs.closeSync(fd);
  return () => {
    if (readJson(file, {})?.nonce === owner.nonce) fs.unlinkSync(file);
  };
}

export function transition(dir, event, data = {}) {
  const file = path.join(dir, 'transitions.jsonl');
  if (fs.existsSync(file) && fs.statSync(file).size > 256 * 1024) fs.renameSync(file, `${file}.1`);
  // Whitelist callers' metadata: never put raw prompts, tool arguments or errors here.
  fs.appendFileSync(file, `${JSON.stringify({ v: 1, time: new Date().toISOString(), event, ...data })}\n`, { mode: 0o600 });
}

export class Accounting {
  constructor(state = {}) {
    this.state = { v: 1, threads: {}, input: 0, cachedInput: 0, output: 0,
      reasoning: 0, outputBytes: 0, errors: {}, repeatedReads: 0, context: 0,
      growth: 0, contextWindow: null, money: null, quota: null, ...state };
    this.reads = new Set();
  }
  invalidate() { this.reads.clear(); }
  usage(thread, total, last, window) {
    if (!total || !last) return;
    const fields = { input: ['inputTokens', 'input_tokens'], cachedInput: ['cachedInputTokens', 'cached_input_tokens'],
      output: ['outputTokens', 'output_tokens'], reasoning: ['reasoningOutputTokens', 'reasoning_output_tokens'] };
    const normalized = {};
    for (const [key, names] of Object.entries(fields)) normalized[key] = Math.max(0, Number(total[names[0]] ?? total[names[1]] ?? 0));
    if (Object.values(normalized).some(n => !Number.isSafeInteger(n))) return;
    const before = this.state.threads[thread] || {};
    // Cumulative snapshots, including both native representations, count once.
    // After reset the new counters start another segment.
    const reset = Object.keys(normalized).some(k => normalized[k] < (before[k] || 0));
    for (const key of Object.keys(fields)) this.state[key] += normalized[key] - (reset ? 0 : before[key] || 0);
    this.state.threads[thread] = normalized;
    // CLI 0.166 compaction reports inputTokens=0 and totalTokens=context estimate.
    const context = Number(last.totalTokens ?? last.total_tokens ?? last.inputTokens ?? last.input_tokens ?? 0);
    this.state.growth = context - this.state.context;
    this.state.context = context;
    this.state.contextWindow = window ?? this.state.contextWindow;
    // Bound per-thread records retained by accounting.
    for (const key of Object.keys(this.state.threads).slice(0, -32)) delete this.state.threads[key];
  }
  event(event, thread = 'rollout') {
    if (event.method === 'thread/tokenUsage/updated') {
      const p = event.params; this.usage(p.threadId, p.tokenUsage.total, p.tokenUsage.last, p.tokenUsage.modelContextWindow);
    }
    const p = event.type === 'event_msg' ? event.payload : null;
    if (p?.type === 'token_count' && p.info) this.usage(thread, p.info.total_token_usage, p.info.last_token_usage, p.info.model_context_window);
    // token_usage_record is intentionally ignored: token_count is the canonical
    // fallback, native events and rollout records must not be mixed in one run.
    if (event.method === 'item/completed') {
      const item = event.params?.item;
      if (item?.type === 'contextCompaction') this.invalidate();
      if (item?.type === 'mcpToolCall') {
        const text = JSON.stringify(item.result || null);
        this.state.outputBytes += Buffer.byteLength(text);
        if (item.status === 'failed' || item.error || item.result?.isError) {
          const kind = classify(item.error?.message || text);
          this.state.errors[kind] = (this.state.errors[kind] || 0) + 1;
        }
        if (item.tool === 'tokensave_read') {
          const args = { ...item.arguments }; delete args.if_digest; delete args.force;
          const key = hash(JSON.stringify([item.server, args]));
          if (this.reads.has(key)) this.state.repeatedReads++;
          this.reads.add(key);
          if (this.reads.size > 512) this.reads.delete(this.reads.values().next().value);
        }
      }
    }
  }
}

export function ingestRollout(file, cursor, accounting) {
  const stat = fs.statSync(file);
  const identity = `${stat.dev}:${stat.ino}`;
  if (cursor.identity && (cursor.identity !== identity || stat.size < cursor.offset)) {
    // Rebuild from current records; rewound snapshots are not new responses.
    accounting.state = { ...new Accounting().state, sourceRebuilt: true };
  }
  let offset = cursor.identity === identity && stat.size >= cursor.offset ? cursor.offset : 0;
  const fd = fs.openSync(file, 'r');
  try {
    // Bounded scan per invocation; offset advances only over complete lines.
    const buffer = Buffer.alloc(Math.min(stat.size - offset, 4 * 1024 * 1024));
    fs.readSync(fd, buffer, 0, buffer.length, offset);
    const end = buffer.lastIndexOf(10);
    if (end >= 0) {
      for (const line of buffer.subarray(0, end).toString('utf8').split('\n')) {
        try { accounting.event(JSON.parse(line), file); } catch { /* malformed local record */ }
      }
      offset += end + 1;
    } else if (buffer.length === 4 * 1024 * 1024) {
      throw new Error('Oversized rollout line; cursor preserved');
    }
  } finally { fs.closeSync(fd); }
  return { identity, offset };
}

export class ReadLedger {
  constructor(generation) { this.generation = generation; this.held = new Map(); }
  invalidate(generation) { this.generation = generation; this.held.clear(); }
  identify({ project, file, range, digest, backend, branch }) {
    return hash(JSON.stringify([fs.realpathSync(project), file, range, digest, backend, branch, this.generation]));
  }
  remember(input) {
    const key = this.identify(input); const repeat = this.held.has(key);
    this.held.set(key, input.digest);
    if (this.held.size > 512) this.held.delete(this.held.keys().next().value);
    return repeat;
  }
  digest(input) { return this.held.get(this.identify(input)); }
}

export function classify(error, write = false) {
  if (write) return 'uncertain-write';
  const s = String(error?.message ?? error);
  if (/permission|denied|unauth|forbidden|401|403/i.test(s)) return 'permission';
  if (/ENOENT|not found|missing.*index/i.test(s)) return 'missing';
  if (/(invalid|bad).*(arg|param|schema)|-32602/i.test(s)) return 'argument';
  if (/ECONNRESET|ETIMEDOUT|temporar|transport closed/i.test(s)) return 'transport';
  return 'protocol';
}

export async function safeRead(operation, { readOnly = false, retries = 2, sleep = ms => new Promise(r => setTimeout(r, ms)) } = {}) {
  for (let attempt = 0; ; attempt++) {
    try { return await operation(); }
    catch (error) {
      if (!readOnly || classify(error) !== 'transport' || attempt >= Math.min(retries, 2)) throw error;
      await sleep(100 * 2 ** attempt);
    }
  }
}

export function utf8Prefix(text, bytes) {
  const data = Buffer.from(text);
  let end = Math.min(data.length, Math.max(0, bytes));
  while (end > 0 && end < data.length && (data[end] & 0xc0) === 0x80) end--;
  return data.subarray(0, end).toString('utf8');
}

// Only explicitly plain text may be bounded. JSON, MCP errors, images and
// structuredContent are returned intact; never parse warning-prefixed text as JSON.
export function boundTextResult(result, budget, dir) {
  if (result.isError || result.structuredContent || !Array.isArray(result.content) ||
      result.content.some(b => b.type !== 'text' || /^[\s]*[\[{]/.test(b.text))) return result;
  const bytes = result.content.reduce((n, b) => n + Buffer.byteLength(b.text), 0);
  if (bytes <= budget) return result;
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, `${crypto.randomUUID()}.json`);
  atomicJson(file, result);
  // Bounded private artifact retention; keep the newest result even if it alone
  // exceeds the retention target. Its contents are never silently truncated.
  const artifacts = fs.readdirSync(dir).filter(name => /^[a-f0-9-]{36}\.json$/.test(name))
    .flatMap(name => {
      const file = path.join(dir, name);
      try { return [{ file, stat: fs.statSync(file) }]; }
      catch (error) { if (error.code === 'ENOENT') return []; throw error; }
    })
    .sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs);
  let retainedBytes = 0;
  for (const [index, item] of artifacts.entries()) {
    retainedBytes += item.stat.size;
    if (item.file !== file && (index >= 64 || retainedBytes > 16 * 1024 * 1024)) {
      try { fs.unlinkSync(item.file); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
  }
  const marker = `\n[full_result=${file}; bytes=${bytes}]`;
  const content = [];
  let remaining = Math.max(0, budget - Buffer.byteLength(marker));
  for (const block of result.content) {
    const text = utf8Prefix(block.text, remaining);
    remaining -= Buffer.byteLength(text);
    if (text) content.push({ ...block, text });
  }
  if (Buffer.byteLength(marker) <= budget) content.push({ type: 'text', text: marker });
  return { ...result, content, _meta: { ...result._meta, harnessFullResult: file, originalTextBytes: bytes } };
}

// One append-only reservation ledger per runner turn. appendFileSync is atomic
// for these small records; each adapter accounts all earlier reservations before
// deciding its allowance. JSON/errors/binary are explicitly outside this cap.
export function reserveTextBudget(file, requested, limit = 13000) {
  const id = crypto.randomUUID();
  fs.appendFileSync(file, `${id} ${requested}\n`, { mode: 0o600 });
  let used = 0;
  for (const line of fs.readFileSync(file, 'utf8').trim().split('\n')) {
    const [key, count] = line.split(' ');
    if (key === id) return Math.min(requested, Math.max(0, limit - used));
    used += Number(count) || 0;
  }
  throw new Error('Missing output reservation');
}
