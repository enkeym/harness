# harness

Один репозиторий на всю агентскую обвязку: правила и скиллы Claude Code, хуки и
гарды, конфиг OpenCode, сервер ragsave. Раскатывается на новую машину одним
`git clone` и `./install.sh`.

## Почему одна репа, а не четыре

Части связаны версиями. `CLAUDE.md` ссылается на скиллы, скиллы описывают
поведение гардов, `settings.json` хардкодит пути в `~/.ai-hooks`, хуки читают
`.claude/bootstrap-ignore`. Разъехавшиеся версии ломаются молча: правило
описывает гард, которого на этой машине ещё нет. Один `git pull` — один
согласованный срез.

## Что внутри

| Каталог | Куда раскатывается | Что это |
| --- | --- | --- |
| `rules/` | `~/.claude/rules/core.md`, `~/.config/opencode/rules/core.md` | `core.md` — общие правила обоих агентов: гейты, выбор инструментов, таблица скиллов |
| `skills/` | `~/.claude/skills`, `~/.config/opencode/skills` | скиллы — одна папка на оба агента |
| `claude/` | `~/.claude/{CLAUDE.md,commands,settings*.json}` | только Claude Code: `CLAUDE.md`, слэш-команды, настройки и хуки; инструмент `Agent` запрещён |
| `ai-hooks/` | `~/.ai-hooks` | security-guard, ask-guard, shell-гард, фоновая синхронизация ragsave, statusline, тесты |
| `ragsave/` | `~/.rag-mcp/{ragsave,tests,README.md}` | MCP-сервер смыслового поиска: код, тесты, зафиксированные зависимости |
| `opencode/` | `~/.config/opencode/{AGENTS.md,agent,plugin,themes,opencode.json,tui.json}` | только OpenCode: `AGENTS.md`, агенты `ask` и `@commit`, плагин tokensave-guard, тема; встроенные `general`/`explore` отключены |
| `bin/` | `~/.local/bin/ragsave`; `mcp-sync.mjs` запускается из репозитория | обёртка запуска `ragsave`, синхронизация MCP |
| `mcp/` | `~/.claude.json` и `opencode/opencode.json` через `bin/mcp-sync.mjs` | `servers.json` — единый список MCP-серверов обоих агентов |
| `shell/` | `~/.bashrc`, `~/.bash_env` | шелл: PATH для node/pnpm/ragsave, ленивый nvm, `BASH_ENV` — переменные для неинтерактивного Bash-тула агента (`GITLAB_TOKEN` для `$GITLAB_HOST` из `~/.git-credentials`, без копии секрета); оба подключают `~/.config/harness/env` |
| `git/` | `~/.gitconfig`, `~/.gitignore_global` | глобальный git: `credential.helper store`, identity через `[include]` из `~/.gitconfig.local`, глобальный ignore для `.claude/`, `.tokensave`, `.ragsave` и прочих агентских каталогов, `hooksPath` на хуки tokensave |
| `tokensave/` | `~/.tokensave/config.toml` | глобальный конфиг tokensave: `wildcard_permissions` (от него зависит правило `mcp__tokensave__*`), дебаунс вотчера, таймаут экстракции |
| `vscode/` | `%APPDATA%\Code\User\{settings.json,keybindings.json,snippets}` — Windows-симлинки на `\\wsl.localhost\…`, только под WSL | VS Code в Windows: настройки (`keyboard.dispatch: keyCode` — сочетания в любой раскладке), клавиши, сниппеты |

История `claude-config` и `ai-hooks` втянута через `git subtree`, так что
`git log` по этим каталогам показывает всю прежнюю историю.

## Раскатка на новой машине

```bash
git clone git@github.com:enkeym/harness.git ~/harness   # каталог любой
cd ~/harness
./install.sh            # симлинки, локальные файлы из шаблонов, MCP-серверы
./install.sh --venv     # venv для ragsave (~250 МБ) + зависимости
```

Playwright MCP репозиторий только регистрирует; пакет и браузер ставятся до
`./install.sh` (иначе сервер пропущен), той же node из nvm, что в PATH агентов:

```bash
npm i -g @playwright/mcp
node "$(npm root -g)/@playwright/mcp/node_modules/playwright/cli.js" install chromium
```

В репозитории нет ни имени пользователя, ни путей этой машины: конфиги
ссылаются на `$HOME`, `~` или `{env:HOME}` (OpenCode). Значения машины —
в двух файлах вне git, `install.sh` создаёт их из `local/*.example`, только если
их ещё нет, и просит заполнить:

- `~/.gitconfig.local` — `[user]` name и email; без них git не даст коммитить;
- `~/.config/harness/env` — `GITLAB_HOST` (хост для `GITLAB_TOKEN`),
  `ANTHROPIC_MODEL`, при нужде `RAGSAVE_HOME` (каталог ragsave вместо
  `~/.rag-mcp`; задать до запуска `install.sh` — в него лягут и симлинки).

VS Code в Windows симлинк из WSL не видит, поэтому `install.sh` создаёт
Windows-симлинки через `mklink`. Без прав администратора это работает только
в режиме разработчика (Параметры → Для разработчиков). Если `mklink` не
сработал, прежний файл возвращается на место. Если WSL не запущен, VS Code
поднимет его при старте, чтобы прочитать настройки.

Хуки tokensave в `claude/settings.json` зовут `/usr/local/bin/tokensave` —
так их пишет `tokensave install`, и `tokensave doctor` сверяет именно путь.
Бинарь в другом месте (Homebrew) — `--check` назовёт оба пути.

### tokensave: только бинарь, без `tokensave install`

Всё, что делает `tokensave install`, харнес уже держит сам: хуки и права — в
`claude/settings.json`, MCP-сервер — в `mcp/servers.json`, правила — в
`skills/tokensave-routing`. Запуск поверх раскатки ломает её (проверено на
tokensave 7.12.1 в песочном HOME):

- `--agent claude` — запись `tokensave` в `~/.claude.json` заменяется на `tokensave
  serve` мимо `mcp-serve.sh`, появляется `~/.claude/rules/tokensave.md` (дубль
  правил в каждой сессии);
- `--agent opencode` — пишет через симлинк прямо в `opencode/opencode.json`
  репозитория: свою MCP-команду и абсолютный путь в `instructions`, плюс
  `~/.config/opencode/tokensave.md`;
- оба заносят агента в `installed_agents` (`~/.tokensave/state.toml`), и после
  каждой смены версии любая команда tokensave тихо повторяет install для них
  (то же делает `tokensave reinstall`).

Поэтому на новой машине:

1. Поставить бинарь tokensave (в `/usr/local/bin`, иначе поправить путь хуков).
   `tokensave install` и `reinstall` не запускать.
2. `./install.sh` — хуки, права, MCP и правила придут из репозитория.
3. `tokensave githooks on` — глобальные git-хуки в `~/.config/git/hooks` (куда уже
   смотрит `core.hooksPath` из `git/gitconfig`). Конфиги агентов он не трогает.

`tokensave doctor` после этого покажет ✘ «MCP server args missing "serve"» и
«rules file not found» и посоветует `tokensave install` — это ожидаемо, совет
не выполнять. Следы уже случившегося install (файлы правил, агенты в
`installed_agents`, чужая MCP-запись) ловит `./install.sh --check`. Откат:

```bash
tokensave uninstall --agent claude     # и/или opencode: убирает правила и installed_agents
git checkout claude/settings.json opencode/opencode.json   # uninstall вырезал из них хуки и права
./install.sh                           # вернуть MCP-запись tokensave
```

Перед `git checkout` стоит смотреть `git diff` этих файлов: своя незакоммиченная
правка там потеряется. `opencode.json.bak` и `tokensave.md.bak` в `~/.config/opencode/`
— бэкапы tokensave, они не нужны.

MCP-серверы берутся из [`mcp/servers.json`](mcp/servers.json), подробности — в
[`mcp/servers.md`](mcp/servers.md).

## Claude Code и OpenCode — что общее

| Что | Claude Code | OpenCode |
| --- | --- | --- |
| Скиллы | `skills/` через `~/.claude/skills` | `skills/` через `~/.config/opencode/skills` (OpenCode видит и `~/.claude/skills`, дубли склеиваются по имени); `commit`, `doctor`, `optimize`, `usage`, `hooks-guards` закрыты в `permission.skill` |
| Правила | `rules/core.md` (автозагрузка `~/.claude/rules/`) + `claude/CLAUDE.md` | `rules/core.md` (`instructions`) + `opencode/AGENTS.md` |
| Субагенты | `permissions.deny: Agent` | `general`/`explore` отключены, `permission.task` — `deny` всем, кроме `commit` |
| MCP | `~/.claude.json` | `opencode.json` → `mcp`; оба из `mcp/servers.json` |
| Shell-гард | хук `ai-hooks/claude/bash-router.mjs` | плагин `opencode/plugin` → `ai-hooks/opencode/tokensave-guard.mjs`; логика одна — `ai-hooks/guard-core.mjs` |
| Гард безопасности | хук `ai-hooks/claude/security-guard.mjs`: `deny` и `ask` | тот же плагин, перед shell-гардом: блокирует только `deny` (секреты); `ask` здесь держит `permission.bash`. Логика одна — `ai-hooks/security-core.mjs` |
| Ask | `/ask`, `/ask-off` (ask-guard) | агент `ask`, включён при старте (`default_agent`), Tab — в `build`: правки, субагенты и запись через tokensave запрещены правами, bash — только чтение git |
| Коммит | `/commit` | `@commit` — субагент со своей моделью и правами (`opencode/agent/commit.md`): коммит, пуш и GitLab API без подтверждений, правка файлов и переписывание истории запрещены; вся процедура из `git-flow`, MR — только по «сделай МР». Из основной сессии `git commit`/`git push` идут через `permission.bash` |

Оба механизма загрузки правил вставляют текст целиком в контекст при старте
сессии — это не ссылка, которую модели нужно открыть. Правило для обоих агентов
пишется в `core.md`, в `CLAUDE.md`/`AGENTS.md` — только то, чего у другого нет.

После правки агента, скилла или `opencode.json` OpenCode нужно перезапустить —
конфиг читается один раз при старте.

## Раскатка агентом

Агент на новой машине стартует без этих правил: `CLAUDE.md`, скиллы и хуки ещё
не на месте, читать ему нечего кроме этого файла. Поэтому порядок ниже —
самодостаточный, выполнять сверху вниз.

1. `./install.sh` — симлинки и MCP-серверы. Отчёт покажет, что встало, что
   уехало в бэкап.
2. `./install.sh --venv` — venv для ragsave. Долго, качает пакеты.
3. `claude mcp list` — все три сервера из `mcp/servers.json` должны быть
   `✔ Connected`.
4. `node ai-hooks/test/test-guards.mjs` и соседние тесты — зелёные.
5. `./install.sh --check` — итоговая проверка, включая внешние зависимости.

**Чего агент сделать не может, это к человеку:**

- `claude` и `opencode` должны быть установлены и залогинены — учётных данных в
  репозитории нет и не будет;
- `tokensave` — сторонний бинарь, ставится отдельно, без `tokensave install`; git-хуки —
  `tokensave githooks on`;
- **перезапуск сессии.** `CLAUDE.md`, `settings.json` и хуки читаются при старте
  сессии. Агент, который только что всё разложил, работает ещё по пустому
  конфигу — правила подхватит только следующая сессия;
- **новый терминал.** `~/.bashrc` экспортирует `BASH_ENV`, и только шелл, в
  котором эта строка уже отработала, передаст его в Bash-тул агента. Claude
  Code, запущенный из старого терминала, `GITLAB_TOKEN` не увидит.

**Абсолютный путь в домашний каталог — поломка.** Хук или команда с
`/home/<имя>/` у другого пользователя не запустится, и отказа не будет — она
просто не найдётся. `./install.sh --check` ищет `/home/<имя>/` и
`/Users/<имя>/` во всех источниках симлинков (кроме тестов и логов) и
называет `файл:строка`. В `permissions.allow` и в месте вызова (скилл,
команда) — одна и та же запись `~/.ai-hooks/…`: правило сравнивается
буквально.

Установка раскладывает **симлинки**, а не копии: правка в `~/.claude/skills`
сразу видна `git status` в этом репозитории, и нет отдельного шага
«синхронизировать обратно» — именно он всегда и разъезжается. Реальный файл,
оказавшийся на месте симлинка, не удаляется, а уезжает в `<имя>.bak-<дата>`.

## Проверка состояния

```bash
./install.sh --check
```

Отчитывается по каждому симлинку и по внешним зависимостям. Нужна после того,
как инструмент мог перезаписать файл целиком: Claude Code переписывает
`settings.json` при смене темы или модели через `/config`, OpenCode —
`opencode.json`. Атомарная запись заменяет симлинк обычным файлом, и правки
дальше идут мимо репозитория; `--check` это ловит, повторный `./install.sh`
чинит, сохранив содержимое в бэкап.

## Чего в репозитории нет

| Что | Почему | Как получить |
| --- | --- | --- |
| `~/.rag-mcp/models` (3.4 ГБ) | модель fastembed, качается сама | первый запуск `ragsave` |
| `~/.rag-mcp/venv` (250 МБ) | воспроизводится из `ragsave/requirements.txt` | `./install.sh --venv` |
| `~/.config/opencode/node_modules` | воспроизводится из `package.json` | `bun install` в каталоге |
| `~/.claude.json` | регистрация MCP вперемешку с историей проектов | `./install.sh` (из `mcp/servers.json`) |
| рантайм `~/.claude` (`projects/`, `sessions/`, `history.jsonl`, `state/`) | локальное состояние машины | создаётся само |
| `tokensave` | сторонний бинарь в `/usr/local/bin` | ставится отдельно, без `tokensave install` (см. «Раскатка на новой машине») |
| `~/.config/git/hooks` | глобальные git-хуки генерирует сам `tokensave` (chain-repo-hook, auto-init) | `tokensave githooks on` |
| `~/.tokensave/{global.db,servers/,state.toml}` | индекс и реестр живых серверов — рантайм машины | создаются сами |
| ключи и токены | секретам не место в git | `~/.claude/.credentials.json`, логин провайдеров |
| `~/.git-credentials` | хранилище `credential.helper store`; из него `~/.bash_env` берёт `GITLAB_TOKEN` | первый `git push` в GitLab с вводом токена |
| `~/.config/harness/env` | значения машины: `GITLAB_HOST`, `ANTHROPIC_MODEL`, `RAGSAVE_HOME` | `./install.sh` (из `local/env.example`), заполнить |
| `~/.gitconfig.local` | git `[user]` этой машины | `./install.sh` (из `local/gitconfig.local.example`), заполнить |

## Тесты

```bash
node ai-hooks/test/test-guards.mjs
node ai-hooks/test/test-ask-mode.mjs
node ai-hooks/test/test-security.mjs
node ai-hooks/test/test-opencode-plugin.mjs
node ai-hooks/test/test-skills.mjs
node ai-hooks/test/test-mcp-sync.mjs
node ai-hooks/test/test-install-check.mjs
```

Прогонять после любой правки в `ai-hooks/`; `test-skills.mjs` — после любой
правки в `skills/`, `rules/core.md`, `CLAUDE.md`, `AGENTS.md` или
`opencode.json`; `test-mcp-sync.mjs` — после правки `bin/mcp-sync.mjs`;
`test-install-check.mjs` — после правки `install.sh`. Красный тест — откат, а не дальнейшая правка.
