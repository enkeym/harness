import fs from 'node:fs';
import path from 'node:path';

export function installShell(home, check) {
  const target = path.join(home, '.bashrc');
  const source = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : '';
  const bootstrap = '[ -f "$HOME/.config/harness/bashrc" ] && . "$HOME/.config/harness/bashrc"\n';
  if (source.startsWith(bootstrap)) return 0;
  if (check) {
    console.error(`✗ ${target} — загрузка harness до выхода из неинтерактивной оболочки`);
    return 1;
  }
  if (fs.existsSync(target)) fs.copyFileSync(target, `${target}.bak-${Date.now()}`, fs.constants.COPYFILE_EXCL);
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(target, bootstrap + source);
  console.log(`✓ ${target} — окружение harness`);
  return 0;
}
