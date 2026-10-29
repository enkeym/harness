// Изолирует временные файлы, журналы индексации и git hooks тестов.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-hooks-test-'));
// Песочницы теста (os.tmpdir()) и его дочерних процессов (mktemp, tempfile)
// создаются внутри dir и уходят вместе с ним при выходе: без этого каждый
// прогон оставлял в /tmp десятки каталогов.
process.env.TMPDIR = dir;
process.on('exit', () => fs.rmSync(dir, { recursive: true, force: true }));
process.env.AI_HOOKS_LOG_DIR = path.join(dir, 'logs');
process.env.AI_HOOKS_STATE_DIR = path.join(dir, 'state');
// Глобальные git-хуки tokensave (core.hooksPath) на каждый commit песочницы
// с .tokensave/ запускали `tokensave sync`, и она оставалась в
// ~/.tokensave/global.db навсегда. Переменные окружения git сильнее
// ~/.gitconfig и наследуются дочерними процессами; каталога хуков нет.
const gitConfigs = Number(process.env.GIT_CONFIG_COUNT) || 0;
process.env[`GIT_CONFIG_KEY_${gitConfigs}`] = 'core.hooksPath';
process.env[`GIT_CONFIG_VALUE_${gitConfigs}`] = path.join(dir, 'git-hooks');
process.env.GIT_CONFIG_COUNT = String(gitConfigs + 1);
delete process.env.CODEX_PROJECT_DIR;
