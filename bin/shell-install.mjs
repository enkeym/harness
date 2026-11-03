import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export function installShell(home, check, env = process.env, platform = process.platform) {
  const shell = path.basename(env.SHELL || 'bash');
  if (!['bash', 'zsh', 'sh'].includes(shell)) {
    console.error(`✗ Shell ${shell}: настройте загрузку окружения harness вручную`);
    return 1;
  }
  const targets = [shell === 'zsh' ? path.join(env.ZDOTDIR || home, '.zshenv') : path.join(home, shell === 'sh' ? '.profile' : '.bashrc')];
  if (shell === 'bash' && platform === 'darwin') {
    targets.push(['.bash_profile', '.bash_login', '.profile'].map(name => path.join(home, name)).find(file => fs.existsSync(file)) || path.join(home, '.bash_profile'));
  }
  return targets.reduce((drift, target) => drift + installStartup(target, check), 0);
}

function installStartup(target, check) {
  if (!fs.existsSync(target)) {
    try {
      if (fs.lstatSync(target).isSymbolicLink()) throw new Error(`Dangling startup link preserved: ${target}`);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  const source = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : '';
  const bootstrap = '[ -f "$HOME/.config/harness/bashrc" ] && . "$HOME/.config/harness/bashrc"\n';
  const user = source.split(/(?<=\n)/).filter(line => line.trimEnd() !== bootstrap.trimEnd()).join('');
  const desired = bootstrap + user;
  if (source === desired) return 0;
  if (check) {
    console.error(`✗ ${target} — загрузка harness до выхода из неинтерактивной оболочки`);
    return 1;
  }
  if (fs.existsSync(target)) fs.copyFileSync(target, `${target}.bak-${Date.now()}-${randomUUID()}`, fs.constants.COPYFILE_EXCL);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, desired);
  console.log(`✓ ${target} — окружение harness`);
  return 0;
}
