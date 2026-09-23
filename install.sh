#!/usr/bin/env bash
# Раскатка харнеса на машину: симлинки из этого репозитория в места, где их ждут
# Claude Code, OpenCode и ragsave.
#
# Симлинки, а не копии: правка в рабочем каталоге сразу видна git'у, и не нужен
# отдельный шаг «синхронизировать обратно» — именно он и разъезжается.
#
#   ./install.sh          создать/починить симлинки
#   ./install.sh --check  только отчёт, ничего не менять
#   ./install.sh --venv   собрать venv для ragsave (~250 МБ) и поставить зависимости
#
# Идемпотентно: повторный запуск ничего не ломает. Реальный файл на месте
# симлинка не удаляется, а уезжает в <имя>.bak-<дата>. Локальные файлы
# машины (LOCALS) создаются из шаблона только там, где их ещё нет.

set -euo pipefail

HARNESS="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STAMP="$(date +%Y%m%d-%H%M%S)"
MODE="${1:-install}"
# Каталог ragsave — тот же, что у bin/ragsave: он ищет там и venv, и код (PYTHONPATH).
RAG_HOME="${RAGSAVE_HOME:-$HOME/.rag-mcp}"

ok=0; fixed=0; drift=0; missing=0

say()  { printf '%s\n' "$*"; }
good() { printf '  \033[32m✓\033[0m %s\n' "$*"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$*"; }
bad()  { printf '  \033[31m✗\033[0m %s\n' "$*"; }

# target|source — цель в системе и путь относительно корня репозитория.
LINKS=(
  "$HOME/.claude/CLAUDE.md|claude/CLAUDE.md"
  "$HOME/.claude/skills|skills"
  "$HOME/.claude/rules/core.md|rules/core.md"
  "$HOME/.claude/commands|claude/commands"
  "$HOME/.claude/settings.json|claude/settings.json"
  "$HOME/.claude/settings.local.json|claude/settings.local.json"
  "$HOME/.ai-hooks|ai-hooks"
  "$RAG_HOME/ragsave|ragsave/ragsave"
  "$RAG_HOME/tests|ragsave/tests"
  "$RAG_HOME/README.md|ragsave/README.md"
  "$HOME/.local/bin/ragsave|bin/ragsave"
  "$HOME/.config/opencode/AGENTS.md|opencode/AGENTS.md"
  "$HOME/.config/opencode/agent|opencode/agent"
  "$HOME/.config/opencode/command|opencode/command"
  "$HOME/.config/opencode/skills|skills"
  "$HOME/.config/opencode/rules/core.md|rules/core.md"
  "$HOME/.config/opencode/plugin|opencode/plugin"
  "$HOME/.config/opencode/themes|opencode/themes"
  "$HOME/.config/opencode/opencode.json|opencode/opencode.json"
  "$HOME/.config/opencode/tui.json|opencode/tui.json"
  "$HOME/.bashrc|shell/bashrc"
  "$HOME/.bash_env|shell/bash_env"
  "$HOME/.gitconfig|git/gitconfig"
  "$HOME/.gitignore_global|git/gitignore_global"
  "$HOME/.tokensave/config.toml|tokensave/config.toml"
)

# target|шаблон — значения этой машины вне git. Копия, а не симлинк: заполненный
# файл не должен попасть в репозиторий, а существующий — быть затёртым шаблоном.
LOCALS=(
  "$HOME/.config/harness/env|local/env.example"
  "$HOME/.gitconfig.local|local/gitconfig.local.example"
)

check_one() {
  local target="$1" src="$HARNESS/$2"

  if [ ! -e "$src" ]; then
    bad "$target — нет источника $2 в репозитории"
    missing=$((missing + 1)); return
  fi

  if [ -L "$target" ]; then
    if [ "$(readlink -f "$target")" = "$(readlink -f "$src")" ]; then
      good "$target"; ok=$((ok + 1)); return
    fi
    warn "$target — симлинк ведёт мимо репозитория: $(readlink "$target")"
    drift=$((drift + 1)); return
  fi

  if [ -e "$target" ]; then
    warn "$target — обычный файл, а не симлинк (инструмент перезаписал его?)"
    drift=$((drift + 1)); return
  fi

  warn "$target — нет"
  drift=$((drift + 1))
}

link_one() {
  local target="$1" src="$HARNESS/$2"

  if [ ! -e "$src" ]; then
    bad "$target — нет источника $2 в репозитории"
    missing=$((missing + 1)); return
  fi

  # Уже указывает куда надо — не трогаем.
  if [ -L "$target" ] && [ "$(readlink -f "$target")" = "$(readlink -f "$src")" ]; then
    good "$target"; ok=$((ok + 1)); return
  fi

  mkdir -p "$(dirname "$target")"

  # Реальный файл или каталог на месте цели уезжает в бэкап, а не удаляется:
  # на первой машине это единственная копия того, что ещё не в репозитории.
  if [ -e "$target" ] && [ ! -L "$target" ]; then
    mv "$target" "$target.bak-$STAMP"
    warn "$target — был обычным файлом, сохранён как $(basename "$target").bak-$STAMP"
  else
    rm -f "$target"
  fi

  ln -s "$src" "$target"
  good "$target → $2"
  fixed=$((fixed + 1))
}

local_one() {
  local target="$1" src="$HARNESS/$2"
  if [ -f "$target" ]; then
    good "$target"; ok=$((ok + 1)); return
  fi
  if [ "$MODE" = "--check" ]; then
    warn "$target — нет, ./install.sh создаст его из $2"
    drift=$((drift + 1)); return
  fi
  if [ ! -f "$src" ]; then
    bad "$target — нет шаблона $2 в репозитории"
    missing=$((missing + 1)); return
  fi
  mkdir -p "$(dirname "$target")"
  cp "$src" "$target"
  warn "$target — создан из $2, заполнить своими значениями"
  fixed=$((fixed + 1))
}

build_venv() {
  local home="$RAG_HOME"
  say "venv для ragsave в $home/venv"
  if [ -x "$home/venv/bin/python" ]; then
    good "venv уже собран"
  else
    python3 -m venv "$home/venv"
    good "venv создан"
  fi
  "$home/venv/bin/python" -m pip install --quiet --upgrade pip
  "$home/venv/bin/python" -m pip install --quiet -r "$HARNESS/ragsave/requirements.txt"
  good "зависимости установлены"
  say "Модель intfloat/multilingual-e5-large (2.24 ГБ) скачается сама"
  say "при первом запуске в $home/models."
}

# Источники симлинков читаются на любой машине как есть: абсолютный путь в
# домашний каталог там — хук, команда или правило прав, которые у другого
# пользователя молча не найдутся. Пути строятся через $HOME, ~ или {env:HOME}. Тесты
# и логи не в счёт: фикстуры нарочно подставляют чужие домашние каталоги,
# а ai-hooks/logs — рантайм этой машины вне git.
machine_paths_check() {
  local srcs=() pair src hits line rest
  for pair in "${LINKS[@]}"; do
    src="$HARNESS/${pair##*|}"
    [ -e "$src" ] || continue
    case " ${srcs[*]:-} " in *" $src "*) ;; *) srcs+=("$src") ;; esac
  done
  [ "${#srcs[@]}" -eq 0 ] && return 0
  # Ничего не нашлось — grep выходит с 1, и без `|| true` pipefail с set -e оборвали бы скрипт.
  hits="$(grep -rnE --exclude-dir=test --exclude-dir=tests --exclude-dir=logs --exclude-dir=node_modules --exclude-dir=__pycache__ \
    '/(home|Users)/[A-Za-z0-9._-]+/' "${srcs[@]}" 2>/dev/null)" || true
  if [ -z "$hits" ]; then
    good "в источниках симлинков нет зашитых /home/<имя>/ и /Users/<имя>/"
    return 0
  fi
  bad "в источниках симлинков зашит домашний каталог — на другой машине не найдётся:"
  while IFS= read -r line; do
    line="${line#"$HARNESS/"}"; rest="${line#*:}"
    warn "  ${line%%:*}:${rest%%:*}"
  done <<<"$hits"
  warn "заменить на \$HOME, ~ или {env:HOME} (opencode.json)"
  drift=$((drift + 1))
}

# Хуки tokensave в settings.json зовут бинарь по абсолютному пути: так их пишет
# `tokensave install`, и `tokensave doctor` сверяет именно путь — голое имя он считает
# поломкой. На машине, где tokensave лежит в другом месте, хуки молча не стартуют.
tokensave_hook_check() {
  local hook_bin
  hook_bin="$(grep -oE '"command": *"[^"]*/tokensave"' "$HARNESS/claude/settings.json" 2>/dev/null | head -1 | sed -E 's/.*"([^"]*)"$/\1/')" || true
  [ -z "$hook_bin" ] && return 0
  if [ "$hook_bin" = "$(command -v tokensave)" ]; then
    good "хуки tokensave в claude/settings.json зовут $hook_bin"
    return 0
  fi
  bad "хуки tokensave в claude/settings.json зовут $hook_bin, а tokensave здесь: $(command -v tokensave) — поправить command в settings.json"
  drift=$((drift + 1))
}

# MCP-серверы — один список mcp/servers.json на оба агента. Claude держит их в
# ~/.claude.json (не симлинкуется), OpenCode — в opencode.json; bin/mcp-sync.mjs
# сверяет или приводит оба к списку.
mcp_sync() {
  say
  if ! command -v node >/dev/null; then
    bad "node не найден — MCP не сверить"; drift=$((drift + 1)); return
  fi
  if [ "${1:-}" = "--check" ]; then
    node "$HARNESS/bin/mcp-sync.mjs" --check || drift=$((drift + 1))
  else
    node "$HARNESS/bin/mcp-sync.mjs" || missing=$((missing + 1))
  fi
}

externals() {
  say
  machine_paths_check
  say
  say "Внешние зависимости (репозиторием не ставятся):"
  command -v claude    >/dev/null && good "claude $(claude --version 2>/dev/null | head -1)" || bad "claude — не найден"
  command -v tokensave >/dev/null && good "tokensave: $(command -v tokensave)"               || bad "tokensave — не найден, поставить отдельно"
  command -v tokensave >/dev/null && tokensave_hook_check
  command -v opencode  >/dev/null && good "opencode: $(command -v opencode)"                 || warn "opencode — не найден (агенты ask и @commit не будут доступны)"
  # Модель @commit — из frontmatter opencode/agent/commit.md, единственное место, где она задана.
  if command -v opencode >/dev/null; then
    commit_model=$(awk -F': *' '/^model:/{print $2; exit}' "$HARNESS/opencode/agent/commit.md")
    commit_provider=${commit_model%%/*}
    opencode models "$commit_provider" 2>/dev/null | grep -qx "$commit_model" \
      && good "модель @commit $commit_model доступна" \
      || warn "$commit_model недоступна — opencode auth login ($commit_provider) или сменить model в opencode/agent/commit.md"
  fi
  command -v python3   >/dev/null && good "python3 $(python3 --version 2>&1 | awk '{print $2}')" || bad "python3 — не найден (нужен для ragsave)"
  [ -x "$RAG_HOME/venv/bin/python" ] && good "venv ragsave собран" || warn "venv ragsave не собран — ./install.sh --venv"
  # gitconfig ссылается на глобальные git-хуки, которые кладёт сам tokensave
  # (chain-repo-hook + auto-init); без них git молча работает без хуков.
  [ -x "$HOME/.config/git/hooks/post-checkout" ] && good "глобальные git-хуки tokensave на месте" || warn "глобальных git-хуков tokensave нет — tokensave ставит их сам при установке"
  # Токен для MR берётся из ~/.git-credentials (credential.helper = store);
  # без файла GITLAB_TOKEN выйдет пустым — агент отдаст описание MR в чат.
  [ -f "$HOME/.git-credentials" ] && good "~/.git-credentials есть (источник GITLAB_TOKEN)" || warn "~/.git-credentials нет — GITLAB_TOKEN будет пустым, MR через API недоступен"
}

case "$MODE" in
  --check)
    say "Проверка симлинков харнеса ($HARNESS):"
    for pair in "${LINKS[@]}"; do check_one "${pair%%|*}" "${pair##*|}"; done
    for pair in "${LOCALS[@]}"; do local_one "${pair%%|*}" "${pair##*|}"; done
    mcp_sync --check
    externals
    say
    say "на месте: $ok, требуют внимания: $drift, нет источника: $missing"
    [ "$drift" -eq 0 ] && [ "$missing" -eq 0 ]
    ;;
  --venv)
    build_venv
    ;;
  install)
    say "Раскатка харнеса из $HARNESS:"
    for pair in "${LINKS[@]}"; do link_one "${pair%%|*}" "${pair##*|}"; done
    for pair in "${LOCALS[@]}"; do local_one "${pair%%|*}" "${pair##*|}"; done
    mcp_sync
    externals
    say
    say "на месте: $ok, создано/починено: $fixed, нет источника: $missing"
    say
    say "Дальше: ./install.sh --venv. MCP-серверы правятся в mcp/servers.json."
    ;;
  *)
    say "Использование: ./install.sh [--check|--venv]"
    exit 2
    ;;
esac
