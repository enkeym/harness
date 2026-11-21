#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync, chmodSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const args = process.argv.slice(2);
function argValue(name, fallback) {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
}
const binary = path.resolve(argValue('binary', 'tokensave'));
const base = argValue('base', '');
const repo = base ? path.join(base, 'repo') : path.join(tmpdir(), `ts-matrix-${process.pid}`, 'repo');

function sh(cmd, cmdArgs, cwd) {
  const r = spawnSync(cmd, cmdArgs, { cwd, encoding: 'utf8', timeout: 120000 });
  return { code: r.status ?? -1, out: (r.stdout ?? '').trim(), err: (r.stderr ?? '').trim() };
}
function git(cwd, ...a) {
  return sh('git', a, cwd);
}
function sleep(ms) {
  spawnSync('sleep', [(ms / 1000).toFixed(1)]);
}
function ts(binaryPath, sub, cwd) {
  return sh(binaryPath, [sub], cwd);
}
function headInfo(cwd) {
  const r = git(cwd, 'show', '-s', '--format=%H %ct %cs', 'HEAD');
  const [sha, ct, cs] = r.out.split(' ');
  const branch = git(cwd, 'rev-parse', '--abbrev-ref', 'HEAD').out;
  return { branch, sha, commit_time: Number(ct), commit_date: cs };
}
function mcpQuery(calls, timeoutMs = 45000) {
  return new Promise((resolve) => {
    const child = spawn(binary, ['serve'], { cwd: repo, stdio: ['pipe', 'pipe', 'pipe'] });
    let buf = '';
    let errBuf = '';
    const got = {};
    const wanted = new Set(calls.map((_, i) => i + 2));
    let settled = false;
    const done = (extra) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { child.kill('SIGKILL'); } catch {}
      resolve({ results: got, stderr: errBuf.slice(-500), ...extra });
    };
    const timer = setTimeout(() => done({ error: 'timeout' }), timeoutMs);
    child.stderr.on('data', (d) => { errBuf += d; });
    child.on('error', (e) => done({ error: String(e) }));
    child.stdout.on('data', (d) => {
      buf += d.toString();
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg.id === 1) {
          child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
          calls.forEach((c, i) => {
            child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: i + 2, method: 'tools/call', params: { name: c.name, arguments: c.args } })}\n`);
          });
        } else if (typeof msg.id === 'number' && wanted.has(msg.id)) {
          got[msg.id] = msg;
          wanted.delete(msg.id);
          if (wanted.size === 0) done({});
        }
      }
    });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'stale-commits-matrix', version: '1.0.0' } } })}\n`);
  });
}
function textOf(msg) {
  const c = msg?.result?.content;
  if (Array.isArray(c) && c[0]?.type === 'text') return c[0].text;
  if (msg?.error) return `ERROR ${JSON.stringify(msg.error)}`;
  return `RAW ${JSON.stringify(msg ?? null)}`;
}
function statusOf(text) {
  try { return JSON.parse(text); } catch { return { parse_error: text.slice(0, 300) }; }
}
function pickStatus(s) {
  return {
    version: s.version,
    last_updated: s.last_updated,
    last_sync_at: s.last_sync_at,
    stale_commits: s.stale_commits ?? 0,
    stale_commits_present: 'stale_commits' in (s ?? {}),
    active_branch: s.active_branch,
    branch_fallback: s.branch_fallback ?? null,
    project_root: s.project_root,
  };
}
const records = [];
async function observe(caseName, step, notes = {}) {
  const q = await mcpQuery([
    { name: 'tokensave_status', args: {} },
    { name: 'tokensave_read', args: { file: 'marker.mjs', mode: 'full', format: 'text' } },
  ]);
  const status = pickStatus(statusOf(textOf(q.results[2])));
  const read = textOf(q.results[3]);
  const rec = {
    case: caseName,
    step,
    ...notes,
    head: headInfo(repo),
    worktree: repo,
    mcp_status: status,
    control: {
      CONTROL_1: read.includes('CONTROL-1'),
      CONTROL_2: read.includes('CONTROL-2'),
      CONTROL_3: read.includes('CONTROL-3'),
      read_error: q.error ?? (read.startsWith('ERROR') ? read.slice(0, 200) : null),
    },
    serve_stderr: q.stderr || null,
  };
  records.push(rec);
  console.log(JSON.stringify(rec));
  return rec;
}

rmSync(repo, { recursive: true, force: true });
mkdirSync(repo, { recursive: true });

console.log(JSON.stringify({ meta: 'run', binary, version: ts(binary, '--version').out, repo, date: new Date().toISOString() }));

git(repo, 'init', '-b', 'main');
git(repo, 'config', 'user.name', 'matrix');
git(repo, 'config', 'user.email', 'matrix@local');
writeFileSync(path.join(repo, 'marker.mjs'), `export const marker = 'CONTROL-1';\n`);
git(repo, 'add', 'marker.mjs');
console.log(JSON.stringify({ meta: 'commit', c: 'c1', ...git(repo, 'commit', '-m', 'c1') }));
console.log(JSON.stringify({ meta: 'init', ...ts(binary, 'init', repo) }));
await observe('setup', 'after-init');
sleep(1200);
console.log(JSON.stringify({ meta: 'sync', step: 'baseline', ...ts(binary, 'sync', repo) }));
await observe('A-noop-clean', 'after-baseline-sync');

sleep(1200);
console.log(JSON.stringify({ meta: 'sync', step: 'noop-2', ...ts(binary, 'sync', repo) }));
await observe('A-noop-clean', 'after-second-noop-sync');

console.log(JSON.stringify({ meta: 'commit', c: 'c2-empty', ...git(repo, 'commit', '--allow-empty', '-m', 'c2') }));
sleep(1200);
console.log(JSON.stringify({ meta: 'sync', step: 'after-empty-commit', ...ts(binary, 'sync', repo) }));
await observe('B-noop-empty-commit', 'after-sync');

appendFileSync(path.join(repo, 'marker.mjs'), `export const marker2 = 'CONTROL-2';\n`);
git(repo, 'add', 'marker.mjs');
console.log(JSON.stringify({ meta: 'commit', c: 'c3-control2', ...git(repo, 'commit', '-m', 'c3') }));
await observe('C-true-staleness', 'before-sync');
sleep(1200);
console.log(JSON.stringify({ meta: 'sync', step: 'after-control2-commit', ...ts(binary, 'sync', repo) }));
await observe('C-true-staleness', 'after-sync');

appendFileSync(path.join(repo, 'marker.mjs'), `export const marker3 = 'CONTROL-3';\n`);
git(repo, 'add', 'marker.mjs');
console.log(JSON.stringify({ meta: 'commit', c: 'c4-control3', ...git(repo, 'commit', '-m', 'c4') }));
const tsDir = path.join(repo, '.tokensave');
function chmodTree(p, mode) {
  chmodSync(p, mode);
  for (const e of readdirSync(p, { withFileTypes: true })) {
    const full = path.join(p, e.name);
    if (e.isDirectory()) chmodTree(full, mode);
    else chmodSync(full, mode);
  }
}
chmodTree(tsDir, 0o500);
const failSync = ts(binary, 'sync', repo);
console.log(JSON.stringify({ meta: 'sync', step: 'readonly-fs-expected-failure', code: failSync.code, out: failSync.out.slice(-300), err: failSync.err.slice(-300) }));
await observe('D-sync-failure', 'after-failed-sync');
chmodTree(tsDir, 0o700);
for (const e of readdirSync(tsDir, { withFileTypes: true })) {
  if (!e.isDirectory()) chmodSync(path.join(tsDir, e.name), 0o600);
}
chmodSync(tsDir, 0o755);
const okSync = ts(binary, 'sync', repo);
console.log(JSON.stringify({ meta: 'sync', step: 'restored', code: okSync.code, out: okSync.out.slice(-300), err: okSync.err.slice(-300) }));
await observe('D-sync-failure', 'after-restored-sync');

const summary = records.map((r) => ({
  case: r.case,
  step: r.step,
  head_time: r.head.commit_time,
  last_updated: r.mcp_status.last_updated,
  last_sync_at: r.mcp_status.last_sync_at,
  relation: r.mcp_status.last_updated < r.head.commit_time ? 'last_updated<HEAD' : r.mcp_status.last_updated === r.head.commit_time ? 'last_updated==HEAD' : 'last_updated>HEAD',
  stale_commits: r.mcp_status.stale_commits,
  controls: [r.control.CONTROL_1, r.control.CONTROL_2, r.control.CONTROL_3].map(Boolean).join('/'),
}));
console.log(JSON.stringify({ meta: 'summary', binary, version: ts(binary, '--version').out, summary }, null, 1));
