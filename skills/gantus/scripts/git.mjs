import { spawnSync } from 'node:child_process';
import { GantusError } from './config.mjs';

const BASE_BRANCHES = new Set(['main', 'master', 'dev', 'develop']);
const GIT_TIMEOUT_MS = 15000;

function git(cwd, args, { allowFailure = false } = {}) {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    timeout: GIT_TIMEOUT_MS
  });
  if (result.error) {
    throw new GantusError('не удалось запустить git', 'git');
  }
  if (!allowFailure && result.status !== 0) {
    throw new GantusError(`git ${args[0]}: команда не выполнена`, 'git');
  }
  return { status: result.status, stdout: result.stdout ?? '' };
}

export function currentBranch(cwd) {
  const result = git(cwd, ['symbolic-ref', '--quiet', '--short', 'HEAD'], { allowFailure: true });
  if (result.status !== 0) return null;
  const value = result.stdout.trim();
  return value === '' ? null : value;
}

export function originRemote(cwd) {
  const result = git(cwd, ['remote', 'get-url', 'origin'], { allowFailure: true });
  if (result.status !== 0) return null;
  const value = result.stdout.trim();
  return value === '' ? null : value;
}

export function assertProjectRemote(config, cwd) {
  if (!config.gitRemote) {
    throw new GantusError('интеграция не включена для этого репозитория: не настроен GANTUS_GIT_REMOTE', 'config');
  }
  const actual = originRemote(cwd);
  if (actual === null || actual !== config.gitRemote) {
    throw new GantusError('git remote origin не совпадает с GANTUS_GIT_REMOTE; действие отменено', 'git');
  }
}

export function validBranchName(cwd, name) {
  if (typeof name !== 'string' || name === '' || name.startsWith('-') || name.includes('@{')) {
    return false;
  }
  const result = git(cwd, ['check-ref-format', '--branch', name], { allowFailure: true });
  return result.status === 0;
}

export function branchExists(cwd, name) {
  return git(cwd, ['show-ref', '--verify', '--quiet', `refs/heads/${name}`], {
    allowFailure: true
  }).status === 0;
}

export function defaultRemoteBranch(cwd) {
  const result = git(cwd, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'], {
    allowFailure: true
  });
  if (result.status !== 0) return null;
  const value = result.stdout.trim();
  const slash = value.indexOf('/');
  return slash >= 0 ? value.slice(slash + 1) : value;
}

export function hasPublishedEvidence(cwd, name) {
  const upstream = git(cwd, ['for-each-ref', '--format=%(upstream)', `refs/heads/${name}`], {
    allowFailure: true
  });
  if (upstream.status === 0 && upstream.stdout.trim() !== '') return true;
  const configuredRemote = git(cwd, ['config', '--get', `branch.${name}.remote`], {
    allowFailure: true
  });
  if (configuredRemote.status === 0 && configuredRemote.stdout.trim() !== '') return true;
  const remoteRefs = git(cwd, ['for-each-ref', '--format=%(refname)', 'refs/remotes'], {
    allowFailure: true
  });
  if (remoteRefs.status === 0) {
    const suffix = `/${name}`;
    return remoteRefs.stdout.split('\n').some((ref) => ref.endsWith(suffix));
  }
  return false;
}

export function head(cwd) {
  return git(cwd, ['rev-parse', 'HEAD']).stdout.trim();
}

export function worktreeState(cwd) {
  return git(cwd, ['status', '--porcelain=v1']).stdout;
}

export function renameCurrentBranch(cwd, oldName, newName) {
  git(cwd, ['branch', '-m', '--', oldName, newName]);
}

export function assertBaseBranch(cwd, name) {
  if (BASE_BRANCHES.has(name) || defaultRemoteBranch(cwd) === name) {
    throw new GantusError(`ветка ${name} является базовой; переименование отменено`, 'git');
  }
}
