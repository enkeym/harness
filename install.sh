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
# симлинка не удаляется, а уезжает в <имя>.bak-<дата>.

set -euo pipefail

HARNESS="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STAMP="$(date +%Y%m%d-%H%M%S)"
MODE="${1:-install}"

ok=0; fixed=0; drift=0; missing=0

say()  { printf '%s\n' "$*"; }
good() { printf '  \033[32m✓\033[0m %s\n' "$*"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$*"; }
bad()  { printf '  \033[31m✗\033[0m %s\n' "$*"; }

# target|source — цель в системе и путь относительно корня репозитория.
LINKS=(
  "$HOME/.claude/CLAUDE.md|claude/CLAUDE.md"
  "$HOME/.claude/skills|claude/skills"
  "$HOME/.claude/commands|claude/commands"
  "$HOME/.claude/settings.json|claude/settings.json"
  "$HOME/.claude/settings.local.json|claude/settings.local.json"
  "$HOME/.ai-hooks|ai-hooks"
  "$HOME/.rag-mcp/ragsave|ragsave/ragsave"
  "$HOME/.rag-mcp/tests|ragsave/tests"
  "$HOME/.rag-mcp/README.md|ragsave/README.md"
  "$HOME/.local/bin/ragsave|bin/ragsave"
  "$HOME/.config/opencode/AGENTS.md|opencode/AGENTS.md"
  "$HOME/.config/opencode/plugin|opencode/plugin"
  "$HOME/.config/opencode/themes|opencode/themes"
  "$HOME/.config/opencode/opencode.json|opencode/opencode.json"
  "$HOME/.config/opencode/tui.json|opencode/tui.json"
  "$HOME/.config/opencode/tokensave.md|opencode/tokensave.md"
  "$HOME/.bashrc|shell/bashrc"
  "$HOME/.bash_env|shell/bash_env"
  "$HOME/.gitconfig|git/gitconfig"
  "$HOME/.gitignore_global|git/gitignore_global"
  "$HOME/.tokensave/config.toml|tokensave/config.toml"
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

build_venv() {
  local home="$HOME/.rag-mcp"
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

# Пути к хукам в settings.json и opencode.json записаны абсолютными: правила
# permissions.allow сопоставляются буквально и $HOME в них не раскрывается.
# Значит домашний каталог на новой машине обязан совпадать, иначе хуки просто
# не запустятся, а отказов не будет — Claude Code молча пропустит несуществующую
# команду. Ловим это здесь, а не через неделю по странному поведению.
home_check() {
  local baked
  baked="$(grep -o '/home/[a-z_][a-z0-9_-]*/\.ai-hooks' "$HARNESS/claude/settings.json" | head -1 | sed 's#/\.ai-hooks##')"
  [ -z "$baked" ] && return 0
  if [ "$baked" = "$HOME" ]; then
    good "домашний каталог совпадает с зашитым в конфигах ($HOME)"
    return 0
  fi
  bad "домашний каталог не совпадает: в конфигах $baked, здесь $HOME"
  warn "хуки не запустятся. Заменить пути во всём репозитории:"
  warn "  grep -rl '$baked' --exclude-dir=.git . | xargs sed -i 's#$baked#$HOME#g'"
  drift=$((drift + 1))
}

externals() {
  say
  home_check
  say
  say "Внешние зависимости (репозиторием не ставятся):"
  command -v claude    >/dev/null && good "claude $(claude --version 2>/dev/null | head -1)" || bad "claude — не найден"
  command -v tokensave >/dev/null && good "tokensave: $(command -v tokensave)"               || bad "tokensave — не найден, поставить отдельно"
  command -v opencode  >/dev/null && good "opencode: $(command -v opencode)"                 || warn "opencode — не найден (нужен только для ask-режима OpenCode)"
  command -v python3   >/dev/null && good "python3 $(python3 --version 2>&1 | awk '{print $2}')" || bad "python3 — не найден (нужен для ragsave)"
  [ -x "$HOME/.rag-mcp/venv/bin/python" ] && good "venv ragsave собран" || warn "venv ragsave не собран — ./install.sh --venv"
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
    externals
    say
    say "на месте: $ok, создано/починено: $fixed, нет источника: $missing"
    say
    say "Дальше: ./install.sh --venv  и  mcp/servers.md для регистрации MCP."
    ;;
  *)
    say "Использование: ./install.sh [--check|--venv]"
    exit 2
    ;;
esac
