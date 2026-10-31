import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

export function playwrightEnv(env = process.env) {
  if (env.PLAYWRIGHT_MCP_EXECUTABLE_PATH) return { PLAYWRIGHT_MCP_EXECUTABLE_PATH: env.PLAYWRIGHT_MCP_EXECUTABLE_PATH };
  if (!env.WSL_DISTRO_NAME) return {};
  for (const dir of (env.PATH || '').split(path.delimiter).filter(Boolean)) {
    const file = path.join(dir, 'chrome.exe');
    try {
      fs.accessSync(file, fs.constants.X_OK);
      if (fs.statSync(file).isFile()) return { PLAYWRIGHT_MCP_EXECUTABLE_PATH: file };
    } catch {}
  }
  const options = { env, encoding: 'utf8', timeout: 10000, stdio: ['ignore', 'pipe', 'pipe'] };
  const script = "$ErrorActionPreference = 'Stop'; foreach ($root in @('HKCU:', 'HKLM:')) { $key = Join-Path $root 'Software\\Microsoft\\Windows\\CurrentVersion\\App Paths\\chrome.exe'; if (Test-Path $key) { (Get-Item $key).GetValue(''); exit 0 } }; exit 1";
  const windowsPath = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], options).trim();
  const executablePath = execFileSync('wslpath', ['-u', windowsPath], options).trim();
  fs.accessSync(executablePath, fs.constants.X_OK);
  if (!fs.statSync(executablePath).isFile()) throw new Error('Chrome executable is not a file');
  return { PLAYWRIGHT_MCP_EXECUTABLE_PATH: executablePath };
}
