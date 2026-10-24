# Перенос на новую машину — чек-лист

Порядок сверху вниз. Подробности каждого шага — в [README](../README.md).

## 0. На старой машине, до переноса

- [ ] `git status` в `~/harness` чистый, `git status -sb` — `main...origin/main` без `ahead`.
- [ ] Скопировать то, чего нет в git:
  - [ ] `~/.git-credentials` — токены GitLab/GitHub (источник `GITLAB_TOKEN`);
  - [ ] `~/.ssh/` — ключи, если клон и пуш идут по SSH;
  - [ ] `~/.config/harness/env` и `~/.gitconfig.local` — можно и заполнить заново;
  - [ ] `~/.claude/projects/*/memory/` — память агента по проектам, при желании.

Индексы `.tokensave/` и `.ragsave/` в проектах не переносить: они машинные.
На новой машине — `tokensave init <путь>` и `ragsave init` в каждом проекте
руками, хуки их не создают.

## 1. Установить вручную

- [ ] `git`, `curl`, `jq` (без `jq` не задаётся git-фильтр `nomodel`).
- [ ] `python3` и `python3-venv` (на Ubuntu `python3 -m venv` без него падает;
      `--venv` проверяет это до сборки).
- [ ] WSL: проекты — в ФС WSL (`~/…`), не на `/mnt/c`: на диске Windows
      inotify не видит правок из Windows, а SQLite-индексы ненадёжны
      (`install.sh` такие назовёт).
- [ ] nvm и node (сейчас v24) — `nvm install 24 && nvm alias default 24`;
      `~/.bashrc` берёт node по default-алиасу nvm.
- [ ] Claude Code: установить, запустить `claude` и залогиниться —
      появится `~/.claude.json`, без него MCP-серверы не зарегистрируются.
- [ ] tokensave — бинарь из релизов
      <https://github.com/aovestdipaperino/tokensave> в любой каталог PATH
      (`/usr/local/bin`, `~/.cargo/bin`): хуки и MCP ищут его по имени.
      Версию прежней машины — `previous_version` в её
      `~/.tokensave/state.toml`. **`tokensave install` /
      `reinstall` не запускать**, даже если `tokensave doctor` советует.
- [ ] WSL + VS Code в Windows: включить «Параметры → Для разработчиков → Режим
      разработчика», иначе `mklink` не создаст симлинки настроек.
- [ ] По необходимости: pnpm; Playwright MCP — только для проектов с
      `/test-browser` (команды в README).

## 2. Раскатка

```bash
git clone git@github.com:enkeym/harness.git ~/harness
cd ~/harness
./install.sh            # ядро: симлинки, локальные файлы из шаблонов, MCP-серверы
./install.sh --personal # только машина автора: ~/.bashrc, git, клавиши, VS Code
./install.sh --venv     # venv для ragsave (~2,6 ГБ с CUDA, без GPU — CPU-сборка)
tokensave githooks on   # глобальные git-хуки tokensave
```

- [ ] В отчёте `install.sh` нет `✗`. Строки `.bak-<дата>` — прежние файлы
      машины, сохранённые рядом: просмотреть и удалить ненужное. Через 30
      дней их назовёт `install.sh --check`, а `/doctor` спросит и удалит.
- [ ] Ядро дописало в свой `~/.bashrc` блок `# >>> harness >>>` — остальное в нём не тронуто.
- [ ] `--personal`: «дописаны строки из .bashrc.bak-…» — строки прежнего `~/.bashrc` (brew,
      conda, cargo) уехали в `~/.config/harness/env` (у `export` в отчёте только имя, значение —
      в самом файле): проверить, лишнее удалить.
- [ ] `--personal`: «перенесены настройки из .gitconfig.bak-…» — настройки прежнего
      `~/.gitconfig`, которых нет в `git/gitconfig`, уехали в `~/.gitconfig.local`.

## 3. Заполнить значения машины

- [ ] `--personal`: `~/.gitconfig.local` — `[user] name` и `email`, если install не перенёс
      их из прежнего `~/.gitconfig` (без них git не коммитит).
- [ ] `~/.config/harness/env` — `GITLAB_HOST`, по желанию `ANTHROPIC_MODEL`, при нужде
      `RAGSAVE_HOME` (его — до `./install.sh`).
- [ ] `~/.git-credentials` на месте, права `600`.

## 4. Перезапуск

- [ ] Закрыть и открыть терминал — блок харнесса в `~/.bashrc` экспортирует `BASH_ENV`, без
      этого Bash-тул агента не увидит `GITLAB_TOKEN`.
- [ ] Новая сессия `claude` из нового терминала — правила, скиллы и хуки
      читаются только при старте сессии.

## 5. Проверить, что всё встало

В терминале:

- [ ] `./install.sh --check` → `требуют внимания: 0, нет источника: 0`.
- [ ] `claude mcp list` → `tokensave` и `ragsave` — `✔ Connected`.
- [ ] `for f in ai-hooks/test/test-*.mjs; do node "$f" >/dev/null || echo "FAIL $f"; done` — ни одного `FAIL`.
- [ ] `~/.rag-mcp/venv/bin/python ~/.rag-mcp/tests/test_ragsave.py` → `0 failed`.
- [ ] `git config user.email` — свой адрес; `[ -n "$GITLAB_TOKEN" ] && echo ok` — `ok`.
- [ ] `tokensave doctor` — ✘ «MCP server args missing "serve"» и «rules file
      not found» ожидаемы, совет `tokensave install` не выполнять.

В сессии Claude Code, в любом проекте:

- [ ] Внизу statusline харнеса (контекст, модель).
- [ ] Ответ по-русски, скиллы грузятся (`/` показывает `/commit`, `/doctor`, `/review`…).
- [ ] Попросить «прочитай README через cat» — shell-гард отказывает и
      называет `tokensave_read`: хуки работают.
- [ ] В проекте после `tokensave init` / `ragsave init` отвечают `tokensave_status`
      и `rag_status`.
- [ ] Первый `rag_search` — модель `multilingual-e5-large` (2.24 ГБ)
      качается в `~/.rag-mcp/models`, это один раз; следующие ≤1 с.
- [ ] `/model` на другую модель → `git status` в `~/harness` остаётся чистым
      (фильтр `nomodel`).
- [ ] `/doctor` — без ошибок.

Что-то красное — `./install.sh` ещё раз (он идемпотентный), затем `/doctor`.
