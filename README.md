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
| `ai-hooks/` | `~/.ai-hooks` | security-guard, ask-guard, роутеры, фоновая синхронизация индексов, statusline, тесты |
| `ragsave/` | `~/.rag-mcp/{ragsave,tests,README.md}` | MCP-сервер смыслового поиска: код, тесты, зафиксированные зависимости |
| `opencode/` | `~/.config/opencode/{AGENTS.md,agent,plugin,themes,opencode.json,tui.json}` | только OpenCode: `AGENTS.md`, агенты `ask` и `@commit`, плагин tokensave-guard, тема; встроенные `general`/`explore` отключены |
| `bin/` | `~/.local/bin/ragsave`; `mcp-sync.mjs` запускается из репозитория | обёртка запуска `ragsave`, синхронизация MCP |
| `mcp/` | `~/.claude.json` и `opencode/opencode.json` через `bin/mcp-sync.mjs` | `servers.json` — единый список MCP-серверов обоих агентов |
| `shell/` | `~/.bashrc`, `~/.bash_env` | шелл: PATH для node/pnpm/ragsave, ленивый nvm, `BASH_ENV` — переменные для неинтерактивного Bash-тула агента (`GITLAB_TOKEN` из `~/.git-credentials`, без копии секрета) |
| `git/` | `~/.gitconfig`, `~/.gitignore_global` | глобальный git: identity, `credential.helper store`, глобальный ignore для `.claude/`, `.tokensave`, `.ragsave` и прочих агентских каталогов, `hooksPath` на хуки tokensave |
| `tokensave/` | `~/.tokensave/config.toml` | глобальный конфиг tokensave: `wildcard_permissions` (от него зависит правило `mcp__tokensave__*`), дебаунс вотчера, таймаут экстракции |

История `claude-config` и `ai-hooks` втянута через `git subtree`, так что
`git log` по этим каталогам показывает всю прежнюю историю.

## Раскатка на новой машине

```bash
git clone git@github.com:enkeym/harness.git ~/harness
cd ~/harness
./install.sh            # симлинки + MCP-серверы в Claude и OpenCode
./install.sh --venv     # venv для ragsave (~250 МБ) + зависимости
```

MCP-серверы берутся из [`mcp/servers.json`](mcp/servers.json), подробности — в
[`mcp/servers.md`](mcp/servers.md).

## Claude Code и OpenCode — что общее

| Что | Claude Code | OpenCode |
| --- | --- | --- |
| Скиллы | `skills/` через `~/.claude/skills` | `skills/` через `~/.config/opencode/skills` (OpenCode видит и `~/.claude/skills`, дубли склеиваются по имени); `commit`, `doctor`, `optimize`, `usage`, `hooks-guards` закрыты в `permission.skill` |
| Правила | `rules/core.md` (автозагрузка `~/.claude/rules/`) + `claude/CLAUDE.md` | `rules/core.md` (`instructions`) + `opencode/AGENTS.md` |
| Субагенты | `permissions.deny: Agent` | `general`/`explore` отключены, `permission.task` — `deny` всем, кроме `commit` |
| MCP | `~/.claude.json` | `opencode.json` → `mcp`; оба из `mcp/servers.json` |
| Гарды tokensave | хуки `ai-hooks/claude/*` | плагин `opencode/plugin` → `ai-hooks/opencode/tokensave-guard.mjs`; логика одна — `ai-hooks/guard-core.mjs` |
| Ask | `/ask`, `/ask-off` (ask-guard) | агент `ask`, включён при старте (`default_agent`), Tab — в `build`: правки, субагенты и запись через tokensave запрещены правами, bash — только чтение git |
| Коммит | `/commit` | `@commit` — субагент на `zai-coding-plan/glm-5.3` со своими правами: коммит, пуш и GitLab API без подтверждений, правка файлов и переписывание истории запрещены; вся процедура из `git-flow`, MR — только по «сделай МР». Из основной сессии `git commit`/`git push` спрашивают через `permission.bash` |

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
- `tokensave` — сторонний бинарь, ставится отдельно;
- **перезапуск сессии.** `CLAUDE.md`, `settings.json` и хуки читаются при старте
  сессии. Агент, который только что всё разложил, работает ещё по пустому
  конфигу — правила подхватит только следующая сессия;
- **новый терминал.** `~/.bashrc` экспортирует `BASH_ENV`, и только шелл, в
  котором эта строка уже отработала, передаст его в Bash-тул агента. Claude
  Code, запущенный из старого терминала, `GITLAB_TOKEN` не увидит.

**Домашний каталог обязан совпадать.** Пути к хукам в `settings.json` и правила
`permissions.allow` абсолютные и буквальные, `$HOME` в них не раскрывается. При
другом имени пользователя хуки не запустятся, и отказа не будет — команда просто
не найдётся. `./install.sh --check` проверяет это первым делом и печатает готовую
команду замены.

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
| `tokensave` | сторонний бинарь в `/usr/local/bin` | ставится отдельно |
| `~/.config/git/hooks` | глобальные git-хуки генерирует сам `tokensave` (chain-repo-hook, auto-init) | появляются при установке `tokensave` |
| `~/.tokensave/{global.db,servers/,state.toml}` | индекс и реестр живых серверов — рантайм машины | создаются сами |
| ключи и токены | секретам не место в git | `~/.claude/.credentials.json`, логин провайдеров |
| `~/.git-credentials` | хранилище `credential.helper store`; из него `~/.bash_env` берёт `GITLAB_TOKEN` | первый `git push` в GitLab с вводом токена |

## Тесты

```bash
node ai-hooks/test/test-guards.mjs
node ai-hooks/test/test-ask-mode.mjs
node ai-hooks/test/test-security.mjs
node ai-hooks/test/test-skills.mjs
```

Прогонять после любой правки в `ai-hooks/`; `test-skills.mjs` — после любой
правки в `skills/`, `rules/core.md`, `CLAUDE.md`, `AGENTS.md` или
`opencode.json`. Красный тест — откат, а не дальнейшая правка.
