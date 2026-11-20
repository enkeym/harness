import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { good, warn, bad } from './report.mjs';
import { resolveCommand } from './command-path.mjs';

const root = path.resolve(import.meta.dirname, '..');
const home = os.homedir();
const args = process.argv.slice(2);
if (args.length > 1) {
  console.error('Использование: node bin/project-identity.mjs [каталог]');
  process.exit(2);
}
const target = path.resolve(args[0] ?? process.cwd());

let mismatch = 0;
const fail = (s) => { bad(s); mismatch++; };
const safeRealpath = (p) => { try { return fs.realpathSync(p); } catch { return p; } };

let phys;
try {
  phys = fs.realpathSync(target);
} catch {
  bad(`каталог недоступен: ${target}`);
  process.exit(1);
}

const picker = [
  '. "$1"',
  'phys="$(cd "$2" 2>/dev/null && pwd -P)" || exit 1',
  'printf \'phys=%s\\n\' "$phys"',
  'boundary="$(git_worktree_root "$phys")" && printf \'worktree=%s\\n\' "$boundary"',
  'ts="$(find_index_root .tokensave/tokensave.db "$phys")" && printf \'tokensave=%s\\n\' "$ts"',
  'rg="$(find_index_root .ragsave/rag.db "$phys")" && printf \'ragsave=%s\\n\' "$rg"',
  'exit 0'
].join('\n');
const found = {};
try {
  const out = execFileSync(
    'bash',
    ['-c', picker, 'picker', path.join(root, 'ai-hooks/bin/index-root.sh'), target],
    { encoding: 'utf8', timeout: 15000, stdio: ['ignore', 'pipe', 'pipe'] }
  );
  for (const line of out.split('\n')) {
    const cut = line.indexOf('=');
    if (cut > 0) found[line.slice(0, cut)] = line.slice(cut + 1);
  }
} catch {
  bad(`не удалось выбрать корень индекса: ${target}`);
  process.exit(1);
}

const git = (...gitArgs) => {
  try {
    return execFileSync('git', gitArgs, { encoding: 'utf8', timeout: 10000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return '';
  }
};
const branchOf = (dir) => {
  const current = git('-C', dir, 'branch', '--show-current');
  if (current) return current;
  const head = git('-C', dir, 'rev-parse', '--short', 'HEAD');
  return head ? `detached ${head}` : 'неизвестна';
};

function tokensaveBinary() {
  if (process.env.AI_HOOKS_TOKENSAVE_CMD) return process.env.AI_HOOKS_TOKENSAVE_CMD;
  const resolved = resolveCommand('tokensave');
  if (resolved) return resolved;
  for (const file of [path.join(home, '.local/bin/tokensave'), '/usr/local/bin/tokensave']) {
    try { fs.accessSync(file, fs.constants.X_OK); return file; } catch {}
  }
  return null;
}
const ragsaveBinary = () => process.env.AI_HOOKS_RAGSAVE_CMD || path.join(home, '.local/bin/ragsave');

function run(cmd, cmdArgs, cwd, env = {}) {
  if (!cmd) return '';
  try {
    return execFileSync(cmd, cmdArgs, {
      cwd,
      encoding: 'utf8',
      timeout: 60000,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe']
    });
  } catch {
    return '';
  }
}

console.log(`Идентичность проекта: ${target}`);
good(`ожидаемый реальный путь: ${phys}`);
if (found.worktree) {
  good(`Git worktree: ${found.worktree}, ветка: ${branchOf(phys)}`);
} else {
  warn('вне Git: обслуживается только явно существующий индекс');
}

console.log('TokenSave:');
if (!found.tokensave) {
  warn('маркер .tokensave/tokensave.db не найден — backend не проверялся');
} else {
  good(`корень индекса: ${found.tokensave} (маркер .tokensave/tokensave.db)`);
  if (fs.existsSync(path.join(found.tokensave, '.tokensave-disable'))) warn('.tokensave-disable: фоновая синхронизация запрещена');
  const bin = tokensaveBinary();
  const status = run(bin, ['status'], found.tokensave, { NO_COLOR: '1' });
  const line = status.split('\n').find((l) => l.includes('Project:'));
  const project = line ? line.slice(line.indexOf('Project:') + 'Project:'.length).replace(/[│\s]+$/u, '').trim() : '';
  const branch = /Branch:\s*\[([^\]]*)\]/.exec(status)?.[1];
  if (!project) {
    warn('статус backend недоступен или нераспознан');
  } else if (safeRealpath(project) !== found.tokensave) {
    fail(`backend обслуживает другой проект: ${project}, ожидаемый: ${found.tokensave}`);
  } else {
    good(`фактический реальный путь backend: ${safeRealpath(project)}`);
  }
  const current = found.worktree ? branchOf(phys) : '';
  if (branch && branch !== 'single-db' && current && branch !== current && !current.startsWith('detached')) {
    warn(`ветка backend ${branch} ≠ ветка worktree ${current}`);
  }
  const headCt = found.worktree ? Number(git('-C', found.worktree, 'log', '-1', '--format=%ct')) : 0;
  let sj = null;
  try { sj = JSON.parse(run(bin, ['status', '-j'], found.tokensave, { NO_COLOR: '1' })); } catch {}
  let controlMtime = 0;
  try { controlMtime = Math.floor(fs.statSync(path.join(found.tokensave, '.tokensave', 'sync.log')).mtimeMs / 1000); } catch {}
  if (headCt && (!sj || typeof sj.last_sync_at !== 'number')) {
    warn('свежесть: статус backend (status -j) недоступен или нераспознан');
  } else if (headCt && sj.last_sync_at < headCt) {
    warn(`отставание по содержимому: last_sync_at ${sj.last_sync_at} раньше HEAD ${headCt} — запустите tokensave sync (контрольный sync.log: ${controlMtime})`);
  } else if (headCt && typeof sj.last_updated === 'number' && sj.last_updated < headCt) {
    warn(`подозрение по commit timestamp: sync после HEAD (last_sync_at ${sj.last_sync_at} ≥ ${headCt}) не обновил last_updated (${sj.last_updated}); живой статус может сохранять stale_commits — не повторяйте sync циклом (маркер успеха sync в 7.16.0 берёт last_updated)`);
  } else if (headCt) {
    good(`индекс свежий: last_sync_at ${sj.last_sync_at} ≥ HEAD ${headCt} (контрольный sync.log: ${controlMtime})`);
  }
  let DatabaseSync = null;
  try {
    const warningListeners = process.rawListeners('warning');
    process.removeAllListeners('warning');
    try { ({ DatabaseSync } = await import('node:sqlite')); } finally {
      for (const listener of warningListeners) process.on('warning', listener);
    }
  } catch {}
  if (DatabaseSync && found.worktree) {
    try {
      const prefix = path.relative(found.tokensave, found.worktree);
      if (!prefix.startsWith('..') && !path.isAbsolute(prefix)) {
        const db = new DatabaseSync(path.join(found.tokensave, '.tokensave', 'tokensave.db'), { readOnly: true });
        const indexed = new Set(db.prepare('select path from files').all().map((r) => r.path));
        db.close();
        const base = prefix ? `${prefix.split(path.sep).join('/')}/` : '';
        const coverageClasses = git('-C', found.worktree, 'ls-files')
          .split('\n')
          .filter(Boolean)
          .filter((p) => p.startsWith(base))
          .map((p) => p.slice(base.length))
          .filter((rel) => rel.endsWith('.jsonc')
            || (!path.basename(rel).includes('.')
              && fs.existsSync(path.join(found.tokensave, rel))
              && (fs.statSync(path.join(found.tokensave, rel)).mode & 0o111) !== 0));
        const uncovered = coverageClasses.filter((rel) => !indexed.has(rel));
        if (uncovered.length) {
          warn(`нет покрытия: ${uncovered.length} отслеживаемых файлов вне индекса: ${uncovered.slice(0, 3).join(', ')} — дополните artifact_extensions/project.json в .tokensave/ (node bin/harness-index-config.mjs)`);
        } else if (coverageClasses.length) {
          good(`покрытие: .jsonc и исполняемые extensionless-файлы есть в индексе (${coverageClasses.length})`);
        }
      }
    } catch {}
  }
  const servers = run(bin, ['servers'], found.tokensave, { NO_COLOR: '1' }).trim();
  if (servers) good(`запущенные серверы: ${servers.split('\n')[0]}`);
}

console.log('RAGSave:');
if (!found.ragsave) {
  warn('маркер .ragsave/rag.db не найден — backend не проверялся');
} else {
  good(`корень индекса: ${found.ragsave} (маркер .ragsave/rag.db)`);
  if (fs.existsSync(path.join(found.ragsave, '.ragsave-disable'))) warn('.ragsave-disable: фоновая синхронизация запрещена');
  const raw = run(ragsaveBinary(), ['status'], found.ragsave);
  let data = null;
  try { data = JSON.parse(raw); } catch {}
  if (!data) {
    warn('статус backend недоступен или нераспознан');
  } else {
    if (safeRealpath(data.project ?? '') !== found.ragsave) {
      fail(`backend обслуживает другой проект: ${data.project}, ожидаемый: ${found.ragsave}`);
    } else {
      good(`фактический реальный путь backend: ${safeRealpath(data.project)}`);
    }
    good(`БД: ${data.db}, файлов: ${data.files ?? '?'}, indexed: ${data.indexed}, autosync: ${data.autosync ?? '?'}, последний sync: ${data.last_sync?.at ?? '?'}`);
  }
}

console.log('Playwright:');
const envFileHasName = (name) => {
  try {
    return fs.readFileSync(path.join(home, '.config/harness/env'), 'utf8')
      .split(/\r?\n/)
      .some((l) => l.trim() === name || l.trim().startsWith(`${name}=`) || l.trim().startsWith(`export ${name}=`));
  } catch {
    return false;
  }
};
if (process.env.PLAYWRIGHT_MCP_EXTENSION_TOKEN || envFileHasName('PLAYWRIGHT_MCP_EXTENSION_TOKEN')) {
  good('PLAYWRIGHT_MCP_EXTENSION_TOKEN задан');
} else {
  warn('PLAYWRIGHT_MCP_EXTENSION_TOKEN не найден — browser-вызовы недоступны');
}

process.exitCode = mismatch ? 1 : 0;
