#!/usr/bin/env bash
# Раскатка харнеса на машину: симлинки из этого репозитория в места, где их ждут
# Claude Code и ragsave.
#
# Симлинки, а не копии: правка в рабочем каталоге сразу видна git'у, и не нужен
# отдельный шаг «синхронизировать обратно» — именно он и разъезжается.
#
#   ./install.sh             создать/починить симлинки ядра (и личного, если оно включено)
#   ./install.sh --personal  то же плюс личные настройки автора харнесса (PERSONAL_*)
#   ./install.sh --check     только отчёт, ничего не менять
#   ./install.sh --venv      собрать venv для ragsave (~2,6 ГБ с CUDA, без GPU — CPU-сборка) и поставить зависимости
#
# Идемпотентно: повторный запуск ничего не ломает. Реальный файл на месте
# симлинка не удаляется, а уезжает в <имя>.bak-<дата>. Локальные файлы
# машины (LOCALS) создаются из шаблона только там, где их ещё нет.

set -euo pipefail

HARNESS="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STAMP="$(date +%Y%m%d-%H%M%S)"
MODE="${1:-install}"
# Личное включает --personal один раз: метка держит выбор, и повторные
# ./install.sh и --check (их зовёт /doctor) ведут личные цели наравне с ядром.
# Удалить метку — выключить личное (симлинки остаются, их убирают руками).
PERSONAL_MARK="$HOME/.config/harness/personal"
PERSONAL=0
if [ "$MODE" = "--personal" ]; then
  MODE=install PERSONAL=1
elif [ -f "$PERSONAL_MARK" ]; then
  PERSONAL=1
fi
# Каталог ragsave — тот же, что у bin/ragsave: он ищет там и venv, и код (PYTHONPATH).
RAG_HOME="${RAGSAVE_HOME:-$HOME/.rag-mcp}"

ok=0; fixed=0; drift=0; missing=0

say()  { printf '%s\n' "$*"; }
good() { printf '  \033[32m✓\033[0m %s\n' "$*"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$*"; }
bad()  { printf '  \033[31m✗\033[0m %s\n' "$*"; }

# target|source — цель в системе и путь относительно корня репозитория.
# Ядро: без него харнесс не работает. Чужой ~/.bashrc оно не заменяет — дописывает
# блок подключения ~/.config/harness/bashrc (bashrc_hook).
LINKS=(
  "$HOME/.claude/CLAUDE.md|claude/CLAUDE.md"
  "$HOME/.claude/skills|skills"
  "$HOME/.claude/rules/core.md|rules/core.md"
  "$HOME/.claude/commands|claude/commands"
  "$HOME/.claude/settings.json|claude/settings.json"
  "$HOME/.ai-hooks|ai-hooks"
  "$RAG_HOME/ragsave|ragsave/ragsave"
  "$RAG_HOME/tests|ragsave/tests"
  "$RAG_HOME/README.md|ragsave/README.md"
  "$HOME/.local/bin/ragsave|bin/ragsave"
  "$HOME/.config/harness/bashrc|shell/harness.bash"
  "$HOME/.bash_env|shell/bash_env"
  "$HOME/.zshenv|shell/zshenv"
  "$HOME/.tokensave/config.toml|tokensave/config.toml"
)

# Личное автора: приглашение и алиасы, глобальный git, клавиши Claude Code
# и VS Code. Только с --personal или меткой: на чужой машине эти файлы свои.
PERSONAL_LINKS=(
  "$HOME/.claude/keybindings.json|claude/keybindings.json"
  "$HOME/.bashrc|shell/bashrc"
  "$HOME/.gitconfig|git/gitconfig"
  "$HOME/.gitignore_global|git/gitignore_global"
)

# target|шаблон — значения этой машины вне git. Копия, а не симлинк: заполненный
# файл не должен попасть в репозиторий, а существующий — быть затёртым шаблоном.
LOCALS=(
  "$HOME/.config/harness/env|local/env.example"
)
PERSONAL_LOCALS=(
  "$HOME/.gitconfig.local|local/gitconfig.local.example"
)

# VS Code стоит в Windows и читает %APPDATA%\Code\User: симлинк WSL туда
# Windows-программе не виден, нужен Windows-симлинк на \\wsl.localhost\....
# Без прав администратора mklink создаёт его только в режиме разработчика.
# На macOS VS Code читает ~/Library/Application Support/Code/User — там хватает
# обычного симлинка, и его ставят те же link_one/check_one, что и LINKS.
VSCODE_LINKS=(settings.json keybindings.json snippets)

# WSL — по признакам самого WSL, а не по cmd.exe в PATH: с appendWindowsPath=false
# его там нет, а Windows-симлинки VS Code всё равно нужны — cmd.exe берётся с диска C.
# WSLInterop-late — имя файла у новых версий WSL с systemd.
CMD_EXE="$(command -v cmd.exe 2>/dev/null || echo /mnt/c/Windows/System32/cmd.exe)"
is_wsl() {
  { [ -n "${WSL_DISTRO_NAME:-}" ] || [ -e /proc/sys/fs/binfmt_misc/WSLInterop ] || [ -e /proc/sys/fs/binfmt_misc/WSLInterop-late ]; } &&
    [ -x "$CMD_EXE" ] && command -v wslpath >/dev/null
}

# cmd.exe из каталога WSL ругается на UNC-путь первой строкой вывода — запуск из /mnt/c.
wincmd() { (cd /mnt/c && "$CMD_EXE" /c "$@") 2>&1 | tr -d '\r'; }

# Цель Windows-симлинка изнутри WSL не прочитать — её показывает `dir /AL`.
win_link_target() {
  wincmd dir /AL "$1" | sed -nE "s/.*<SYMLINKD?> +${2//./\\.} \[(.*)\]\$/\1/p"
}

# Каталог настроек VS Code (в WSL — в виде /mnt/c/...); пусто — не WSL и не macOS
# или VS Code нет.
vscode_dir() {
  local appdata dir=""
  if is_wsl; then
    appdata="$(wincmd 'echo %APPDATA%')"
    [ -n "$appdata" ] || return 0
    dir="$(wslpath -u "$appdata")/Code/User"
  elif [ "$(uname -s 2>/dev/null)" = Darwin ]; then
    dir="$HOME/Library/Application Support/Code/User"
  fi
  [ -n "$dir" ] && [ -d "$dir" ] && printf '%s' "$dir"
  return 0
}

vscode_one() {
  local dir="$1" name="$2" src="$HARNESS/vscode/$2"
  local want wdir have out flag=""
  want="$(wslpath -w "$src")"
  wdir="$(wslpath -w "$dir")"
  have="$(win_link_target "$wdir" "$name")" || true

  if [ "$have" = "$want" ]; then
    good "VS Code $name"; ok=$((ok + 1)); return
  fi
  if [ "$MODE" = "--check" ]; then
    warn "VS Code $name — не симлинк в харнесс, ./install.sh его создаст"
    drift=$((drift + 1)); return
  fi

  if [ -e "$dir/$name" ] || [ -L "$dir/$name" ]; then
    mv "$dir/$name" "$dir/$name.bak-$STAMP"
  fi
  [ -d "$src" ] && flag="/D"
  out="$(wincmd mklink $flag "$wdir\\$name" "$want")" || true
  if [ "$(win_link_target "$wdir" "$name")" = "$want" ]; then
    good "VS Code $name → vscode/$name"
    [ -e "$dir/$name.bak-$STAMP" ] && warn "VS Code $name — прежний сохранён как $name.bak-$STAMP"
    fixed=$((fixed + 1))
  else
    # Без симлинка VS Code остался бы без настроек — возвращаем прежний файл.
    [ -e "$dir/$name.bak-$STAMP" ] && mv "$dir/$name.bak-$STAMP" "$dir/$name"
    bad "VS Code $name — mklink не сработал: $out"
    warn "включить Параметры Windows → Для разработчиков → Режим разработчика и повторить ./install.sh"
    missing=$((missing + 1))
  fi
}

# VSCODE_DIR запоминается для backups_check: cmd.exe запускается долго.
VSCODE_DIR=""
vscode_links() {
  local name
  [ "$PERSONAL" = 1 ] || return 0
  VSCODE_DIR="$(vscode_dir)"
  [ -n "$VSCODE_DIR" ] || return 0
  for name in "${VSCODE_LINKS[@]}"; do
    if is_wsl; then
      vscode_one "$VSCODE_DIR" "$name"
    elif [ "$MODE" = "--check" ]; then
      check_one "$VSCODE_DIR/$name" "vscode/$name"
    else
      link_one "$VSCODE_DIR/$name" "vscode/$name"
    fi
  done
}

# ~/.zshenv читает только zsh: без него и без прежнего файла цель пропускается,
# чтобы не класть в HOME лишнего. Поставят zsh — следующий ./install.sh её создаст.
wanted() {
  [ "$1" = "$HOME/.zshenv" ] || return 0
  command -v zsh >/dev/null || [ -e "$1" ] || [ -L "$1" ]
}

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

# Установщики (brew, conda, cargo, sdkman, rustup) дописывают себя в ~/.bashrc
# или ~/.zshenv, а link_one увозит его в бэкап — PATH к ним молча пропадает.
# Строки настройки из бэкапа $1, которых нет в своём файле харнесса $2 и в env,
# дописываются в ~/.config/harness/env: его подключают ~/.bashrc и ~/.bash_env,
# а через него и ~/.zshenv. Только строки верхнего уровня и блоки
# `# >>> … >>>`: строка из середины if/case без своего блока сломала бы env.
# ~/.local/bin ставит ядро (shell/harness.bash), nvm и pnpm — личный shell/bashrc:
# nvm лениво, и копия `. nvm.sh` из бэкапа вернула бы его загрузку
# на каждый шелл. Без личного свои nvm и pnpm в env — не дубль.
# В выводе у `export NAME=…` только имя: в значениях бывают токены (GITLAB_TOKEN).
# Регэкспы без обратных слэшей: awk -v раскрывает в значении escape-последовательности.
SETUP_RE='^(export +[A-Za-z_][A-Za-z0-9_]*=|PATH=|eval |alias |([[].*[]] *&& *)?([.]|source) )'
BASHRC_OWN='[.]local/bin|harness/env|harness/bashrc|bash_env'
[ "$PERSONAL" = 1 ] && BASHRC_OWN="NVM_DIR|nvm[.]sh|PNPM_HOME|$BASHRC_OWN"
# $2 — свой файл харнесса, дальше — что он подключает: их строки тоже свои.
shell_migrate() {
  local bak="$HOME/$1.bak-$STAMP" own_file="$2" env="$HOME/.config/harness/env" lines line f known=()
  shift
  for f in "$@"; do known+=("$HARNESS/$f"); done
  [ -f "$bak" ] && [ -f "$env" ] || return 0
  lines="$(awk -v bak="$bak" -v own="$BASHRC_OWN" -v setup="$SETUP_RE" '
    function trim(s) { sub(/^[ \t]+/, "", s); sub(/[ \t]+$/, "", s); return s }
    FILENAME != bak { known[trim($0)] = 1; next }
    blk { if (!drop) print; if ($0 ~ /^# <<< .* <<</) blk = 0; next }
    /^# >>> .* >>>/ { blk = 1; drop = (trim($0) in known); if (!drop) print; next }
    $0 ~ setup { if (!(trim($0) in known) && $0 !~ own) print }
  ' "${known[@]}" "$env" "$bak")" || true
  [ -n "$lines" ] || return 0
  printf '\n# Перенесено install.sh из ~/%s: строк нет в %s.\n%s\n' "$(basename "$bak")" "$own_file" "$lines" >>"$env"
  warn "$env — дописаны строки из $(basename "$bak"), которых нет в $own_file:"
  while IFS= read -r line; do
    if [[ $line =~ ^[[:space:]]*export[[:space:]]+([A-Za-z_][A-Za-z0-9_]*)= ]]; then
      warn "  export ${BASH_REMATCH[1]}"
    else
      warn "  $line"
    fi
  done <<<"$lines"
  fixed=$((fixed + 1))
}

# Прежний ~/.gitconfig разработчика — его имя и почта, хелпер учётных данных,
# safe.directory, алиасы — link_one увозит в бэкап, и git молча теряет их.
# Каждая пара ключ=значение бэкапа, которой нет ни в git/gitconfig, ни в
# ~/.gitconfig.local, дописывается в local через `git config --add`: порядок
# многозначных ключей (сброс `helper =` перед своим хелпером) сохраняется, а
# local подключается последним — значение разработчика перекрывает общее.
# include самого local пропускается: он подключил бы себя же. core.hooksPath не
# переносится: local перекрыл бы им каталог хуков харнеса, и git-хуки tokensave
# молча выключились бы — свои хуки из того каталога разбирает /doctor. В выводе
# только ключи: в значениях бывают токены (http.extraheader, url с user:token@).
gitconfig_migrate() {
  local bak="$HOME/.gitconfig.bak-$STAMP" loc="$HOME/.gitconfig.local" entry key val own hooks="" moved=()
  [ -f "$bak" ] && [ -f "$loc" ] || return 0
  if ! command -v git >/dev/null; then
    bad "git не найден — настройки из $(basename "$bak") не перенесены в $loc"
    missing=$((missing + 1)); return
  fi
  while IFS= read -r -d '' entry; do
    key="${entry%%$'\n'*}"
    # Ключ без значения (`[core] bare`) — булево true.
    if [ "$key" = "$entry" ]; then val=true; else val="${entry#*$'\n'}"; fi
    case "$key" in include.path|includeif.*.path) case "$val" in *.gitconfig.local) continue ;; esac ;; esac
    if [ "$key" = core.hookspath ]; then
      own="$(git config -f "$HARNESS/git/gitconfig" --get core.hooksPath 2>/dev/null)" || true
      [ "${val/#\~/$HOME}" = "${own/#\~/$HOME}" ] || hooks="$val"
      continue
    fi
    git config -f "$HARNESS/git/gitconfig" --fixed-value --get-all "$key" "$val" >/dev/null 2>&1 && continue
    git config -f "$loc" --fixed-value --get-all "$key" "$val" >/dev/null 2>&1 && continue
    git config -f "$loc" --add "$key" "$val"
    moved+=("$key")
  done < <(git config -f "$bak" -z --list 2>/dev/null)
  [ -z "$hooks" ] || warn "core.hooksPath = $hooks из $(basename "$bak") не перенесён: он выключил бы git-хуки tokensave — свои хуки оттуда переносит /doctor"
  [ "${#moved[@]}" -gt 0 ] || return 0
  warn "$loc — перенесены настройки из $(basename "$bak"), которых нет в git/gitconfig:"
  for entry in "${moved[@]}"; do warn "  $entry"; done
  fixed=$((fixed + 1))
}

# На уже настроенной машине link_one увозит в бэкап то, что Claude Code и
# tokensave читали раньше: свои скиллы и команды, глобальный CLAUDE.md, ключи
# settings.json и keybindings.json. Здесь — что из этого своё, чего нет в
# харнессе. install сверяет бэкап этого запуска, --check — живую цель, пока она
# обычный файл или каталог. Только отчёт без счёта в drift (код 1 даёт
# check_one): в claude/settings.json и skills/ пишет /doctor с ответа
# пользователя — в репозиторий не должны уехать машинные пути и токены из env.
# target|источник|вид: json — bin/claude-diff.mjs, text — число своих строк,
# dir — свои и изменённые элементы верхнего уровня без скрытых.
REPORTS=(
  "$HOME/.claude/settings.json|claude/settings.json|json"
  "$HOME/.claude/CLAUDE.md|claude/CLAUDE.md|text"
  "$HOME/.claude/skills|skills|dir"
  "$HOME/.claude/commands|claude/commands|dir"
  "$HOME/.tokensave/config.toml|tokensave/config.toml|text"
)
PERSONAL_REPORTS=(
  "$HOME/.claude/keybindings.json|claude/keybindings.json|json"
)

# Дальше все проходы (раскатка, отчёты, бэкапы, машинные пути) идут по общим
# массивам: личное включено — его цели в них, иначе не существуют для скрипта.
if [ "$PERSONAL" = 1 ]; then
  LINKS+=("${PERSONAL_LINKS[@]}")
  LOCALS+=("${PERSONAL_LOCALS[@]}")
  REPORTS+=("${PERSONAL_REPORTS[@]}")
fi
personal_label() {
  if [ "$PERSONAL" = 1 ]; then printf 'ядро и личное'; else printf 'только ядро (личное — ./install.sh --personal)'; fi
}

# Чужой ~/.bashrc не заменяется: ядро дописывает в него один блок, подключающий
# shell/harness.bash (~/.local/bin, BASH_ENV, env, обёртки init). Тот же блок стоит
# в личном shell/bashrc — ~/.bashrc-симлинк на него не трогается: допись ушла
# бы сквозь симлинк в репозиторий. Блок ищется по строке-заголовку.
BASHRC_BLOCK='# >>> harness >>>
[ -f "$HOME/.config/harness/bashrc" ] && . "$HOME/.config/harness/bashrc"
# <<< harness <<<'
bashrc_hook() {
  local rc="$HOME/.bashrc"
  # С личным ~/.bashrc ведёт LINKS: не симлинк — его уже назвал check_one.
  [ "$PERSONAL" = 1 ] && return 0
  [ "$(readlink -f "$rc")" = "$(readlink -f "$HARNESS/shell/bashrc")" ] && return 0
  if grep -qxF '# >>> harness >>>' "$rc" 2>/dev/null; then
    good "$rc — подключает ядро харнесса"; ok=$((ok + 1)); return
  fi
  if [ "$MODE" = "--check" ]; then
    warn "$rc — не подключает ~/.config/harness/bashrc, ./install.sh допишет блок"
    drift=$((drift + 1)); return
  fi
  printf '\n%s\n' "$BASHRC_BLOCK" >>"$rc"
  good "$rc — дописан блок подключения ядра харнесса"
  fixed=$((fixed + 1))
}
backup_report() {
  local entry target src kind old own lines x name n=0
  for entry in "${REPORTS[@]}"; do
    IFS='|' read -r target src kind <<<"$entry"
    own="$HARNESS/$src" old="$target.bak-$STAMP" lines=""
    [ "$MODE" = "--check" ] && old="$target"
    # Нет источника — его уже назвали link_one/check_one.
    [ -e "$old" ] && [ ! -L "$old" ] && [ -e "$own" ] || continue
    case "$kind" in
      json)
        if ! command -v node >/dev/null; then
          warn "$old — node не найден, свои ключи не сравнены с $src"
          n=$((n + 1)); continue
        fi
        lines="$(node "$HARNESS/bin/claude-diff.mjs" "$old" "$own")" || true
        ;;
      text)
        # diff выходит с 1 на различии, grep -c — с 1 на нуле совпадений.
        x="$(diff "$own" "$old" | grep -c '^>')" || true
        [ "${x:-0}" -gt 0 ] || continue
        warn "$old — отличается от харнесса ($src), строк своих: $x"
        n=$((n + 1)); continue
        ;;
      dir)
        [ -d "$old" ] && [ -d "$own" ] || continue
        for x in "$old"/*; do
          [ -e "$x" ] || continue
          name="$(basename "$x")"
          if [ ! -e "$own/$name" ]; then
            lines+="свой: $name"$'\n'
          elif [ -n "$(diff -rq "$own/$name" "$x" 2>&1)" ]; then
            lines+="изменён: $name"$'\n'
          fi
        done
        ;;
    esac
    [ -n "$lines" ] || continue
    warn "$old — своё, чего нет в харнессе ($src):"
    while IFS= read -r x; do [ -z "$x" ] || warn "  $x"; done <<<"$lines"
    n=$((n + 1))
  done
  [ "$n" -eq 0 ] || warn "своё из прежних настроек — /doctor перенесёт каждый пункт в харнесс или оставит в бэкапе"
}

# Мусор в env: перенос из бэкапов разных машин, ручные вставки, удалённый brew.
# Только отчёт — какие строки убрать, решает /doctor. Смотрятся строки настройки
# верхнего уровня (SETUP_RE) вне блоков `# >>> … >>>`: повтор строки внутри
# двух блоков (`fi`) — не дубль. Мёртвый путь — бинарь в `eval "$(… …)"`, файл
# в `.`/`source`, каталог в PATH; раскрываются только $HOME, ${HOME} и ~.
# Свои строки — ядра, а с личным и shell/bashrc: без него nvm и pnpm ставит env.
env_check() {
  local env="$HOME/.config/harness/env" hits n line kind p known=("$HARNESS/shell/harness.bash")
  [ -f "$env" ] || return 0
  [ "$PERSONAL" = 1 ] && known+=("$HARNESS/shell/bashrc")
  hits="$(awk -v env="$env" -v own="$BASHRC_OWN" -v setup="$SETUP_RE" '
    function trim(s) { sub(/^[ \t]+/, "", s); sub(/[ \t]+$/, "", s); return s }
    FILENAME != env { known[trim($0)] = 1; next }
    /^# >>> .* >>>/ { blk = 1; next }
    blk { if ($0 ~ /^# <<< .* <<</) blk = 0; next }
    $0 !~ setup { next }
    { t = trim($0) }
    t in first { print FNR "|dup|" first[t]; next }
    { first[t] = FNR }
    t in known || t ~ own { print FNR "|own|"; next }
    match(t, /^eval "[$][(][^ )"]+/) { print FNR "|bin|" substr(t, 9, RLENGTH - 8); next }
    match(t, /([.]|source) +"?[^ "]+/) {
      s = substr(t, RSTART, RLENGTH); sub(/^([.]|source) +"?/, "", s); print FNR "|file|" s; next
    }
    /PATH=/ {
      s = t; sub(/.*PATH="?/, "", s); sub(/".*/, "", s)
      n = split(s, part, ":"); for (i = 1; i <= n; i++) if (part[i] !~ /^[$][{]?PATH/) print FNR "|dir|" part[i]
    }
  ' "${known[@]}" "$env")" || true
  n=0
  while IFS='|' read -r line kind p; do
    [ -n "$line" ] || continue
    p="${p/#\~/$HOME}"; p="${p//\$\{HOME\}/$HOME}"; p="${p//\$HOME/$HOME}"
    case "$kind" in
      dup) warn "$env:$line — дубль строки $p" ;;
      own) warn "$env:$line — это уже ставит харнесс" ;;
      bin) [ "${p#/}" != "$p" ] && [ ! -x "$p" ] && warn "$env:$line — нет бинаря $p" || continue ;;
      file) [ "${p#/}" != "$p" ] && [ ! -e "$p" ] && warn "$env:$line — нет файла $p" || continue ;;
      dir) [ "${p#/}" != "$p" ] && [ ! -d "$p" ] && warn "$env:$line — нет каталога $p в PATH" || continue ;;
    esac
    n=$((n + 1))
  done <<<"$hits"
  if [ "$n" -eq 0 ]; then
    good "$env — без дублей и мёртвых путей"
    return 0
  fi
  warn "убрать эти строки из $env — /doctor чистит их сам"
  drift=$((drift + 1))
}

# Бэкапы <имя>.bak-<дата> рядом с целями LINKS, LOCALS и в папке VS Code: install
# называет каждый при создании, но не убирает. Старше BAK_DAYS дней — в отчёт,
# без счёта в drift: удалять или нет, решает пользователь в /doctor. Дата — из имени:
# mv сохраняет mtime файла, и по нему свежий бэкап старого файла выглядел бы старым.
# `date -d` — GNU, `date -v` — BSD (macOS).
BAK_DAYS=30
backups_check() {
  local cutoff pair d f day dirs=() seen=" " n=0
  cutoff="$(date -d "$BAK_DAYS days ago" +%Y%m%d 2>/dev/null || date -v-"$BAK_DAYS"d +%Y%m%d 2>/dev/null)" || return 0
  for pair in "${LINKS[@]}" "${LOCALS[@]}"; do dirs+=("$(dirname "${pair%%|*}")"); done
  [ -z "$VSCODE_DIR" ] || dirs+=("$VSCODE_DIR")
  for d in "${dirs[@]}"; do
    case "$seen" in *" $d "*) continue ;; esac
    seen+="$d "
    for f in "$d"/*.bak-* "$d"/.*.bak-*; do
      day="${f##*.bak-}"; day="${day%%-*}"
      [[ $day =~ ^[0-9]{8}$ ]] && [ "$day" -lt "$cutoff" ] || continue
      warn "$f — бэкап старше $BAK_DAYS дней"
      n=$((n + 1))
    done
  done
  [ "$n" -eq 0 ] || warn "старые бэкапы — /doctor спросит, какие удалить"
}

# Проекты, где шли сессии Claude, без индекса: на новой машине клон приходит
# без .tokensave/ и .ragsave/, а хуки сами индекс не создают. Путь — из поля cwd
# транскрипта: имя каталога в ~/.claude/projects не раскодируется (любой
# не алфанумерик → -). Только git-репозитории кроме $HOME; .ragsave-disable снимает
# ragsave. Индекс создаёт пользователь — отчёт без счёта в drift. Команда одна:
# второй индекс достраивает bin/project-init.sh (обёртки shell, SessionStart).
projects_check() {
  local d t cwd need n=0
  for d in "$HOME/.claude/projects"/*/; do
    cwd=""
    for t in "$d"*.jsonl; do
      [ -f "$t" ] || continue
      cwd="$(grep -m1 -o '"cwd":"[^"]*"' "$t" 2>/dev/null | head -1)" || true
      [ -n "$cwd" ] && break
    done
    cwd="${cwd#\"cwd\":\"}"; cwd="${cwd%\"}"
    [ -n "$cwd" ] && [ "$cwd" != "$HOME" ] && [ -e "$cwd/.git" ] || continue
    # Диск Windows из WSL (drvfs, 9p): inotify не видит правок из Windows, а
    # SQLite-индексы в WAL на нём ненадёжны и медленны.
    case "$cwd" in /mnt/[a-z]/*) warn "$cwd — на диске Windows: индексы и синк там ненадёжны, держать проект в ФС WSL (~/…)" ;; esac
    need=""
    [ -d "$cwd/.tokensave" ] || need="tokensave init $cwd"
    [ -n "$need" ] || [ -f "$cwd/.ragsave/rag.db" ] || [ -e "$cwd/.ragsave-disable" ] || need="cd $cwd && ragsave init"
    [ -n "$need" ] || continue
    warn "$cwd — нет индекса: $need"
    n=$((n + 1))
  done
  [ "$n" -eq 0 ] || warn "проекты без индекса — /doctor предложит команды, индекс создаёт пользователь, второй достроится сам"
}

build_venv() {
  local home="$RAG_HOME" py=python3
  say "venv для ragsave в $home/venv"
  # sqlite-vec грузится через enable_load_extension, а у системного python macOS
  # (/usr/bin/python3) его нет — venv на нём собрался бы, а ragsave упал бы на первом индексе.
  [ -x "$home/venv/bin/python" ] && py="$home/venv/bin/python"
  if ! "$py" -c 'import sqlite3, sys; sys.exit(not hasattr(sqlite3.Connection, "enable_load_extension"))' 2>/dev/null; then
    bad "$py без sqlite3 enable_load_extension — sqlite-vec не загрузить"
    warn "нужен python с расширениями sqlite (на macOS: brew install python), старый venv — удалить, затем ./install.sh --venv"
    return 1
  fi
  if [ -x "$home/venv/bin/python" ]; then
    good "venv уже собран"
  else
    # Debian/Ubuntu вырезают ensurepip из python3: venv без пакета python3-venv
    # падает на полпути и оставляет каталог без pip.
    if ! python3 -c 'import ensurepip' 2>/dev/null; then
      bad "python3 без ensurepip — venv не собрать"
      warn "Debian/Ubuntu: sudo apt install python3-venv, затем ./install.sh --venv"
      return 1
    fi
    python3 -m venv "$home/venv"
    good "venv создан"
  fi
  "$home/venv/bin/python" -m pip install --quiet --upgrade pip
  # requirements.txt — полный freeze с onnxruntime-gpu вместо onnxruntime, которого
  # просит fastembed: без --no-deps pip доставит CPU-сборку поверх, а обе пишут в
  # один пакет onnxruntime. Сборку другого вида из старого venv — убрать по той же причине.
  # Без NVIDIA (nvidia-smi нет или драйвер не отвечает) GPU-сборка бесполезна:
  # ставим CPU-сборку той же версии без пакетов nvidia-* (~2 ГБ), а оставшиеся
  # от прежней GPU-сборки удаляем.
  local req="$HARNESS/ragsave/requirements.txt" other=onnxruntime kind="GPU (onnxruntime-gpu)"
  local installed own
  if ! nvidia-smi -L >/dev/null 2>&1; then
    other=onnxruntime-gpu kind="CPU (onnxruntime): nvidia-smi не нашёл GPU"
  fi
  installed=$("$home/venv/bin/python" -m pip list --format=freeze 2>/dev/null || true)
  own=$(grep -E '^onnxruntime-gpu==' "$req")
  [ "$other" = onnxruntime-gpu ] && own="onnxruntime==${own#onnxruntime-gpu==}"
  if [ "$other" = onnxruntime ]; then
    "$home/venv/bin/python" -m pip install --quiet --no-deps -r "$req"
  else
    "$home/venv/bin/python" -m pip install --quiet --no-deps -r <(sed -E '/^nvidia-/d; s/^onnxruntime-gpu==/onnxruntime==/' "$req")
  fi
  # Чужая сборка удаляет общий каталог onnxruntime/ вместе с файлами своей: стояли
  # обе (fastembed дотянул CPU поверх GPU) — pip install -r свою не тронул бы, она
  # уже числится установленной, и import onnxruntime падал бы. Поэтому своя
  # переустанавливается после удаления чужой.
  if grep -qiE "^${other//-/[-_]}==" <<<"$installed"; then
    "$home/venv/bin/python" -m pip uninstall --quiet -y "$other"
    "$home/venv/bin/python" -m pip install --quiet --no-deps --force-reinstall "$own"
  fi
  if [ "$other" = onnxruntime-gpu ]; then
    local nvidia
    nvidia=$(grep -ioE '^nvidia-[^=]+' <<<"$installed" || true)
    # shellcheck disable=SC2086 # имена пакетов без пробелов, по одному в строке
    [ -n "$nvidia" ] && "$home/venv/bin/python" -m pip uninstall --quiet -y $nvidia
  fi
  good "зависимости установлены, эмбеддинги на $kind"
  say "Модель intfloat/multilingual-e5-large (2.24 ГБ) скачается сама"
  say "при первом запуске в $home/models."
}

# Источники симлинков читаются на любой машине как есть: абсолютный путь в
# домашний каталог там — хук, команда или правило прав, которые у другого
# пользователя молча не найдутся. Пути строятся через $HOME или ~. Тесты
# и логи не в счёт: фикстуры нарочно подставляют чужие домашние каталоги,
# а ai-hooks/logs — рантайм этой машины вне git.
machine_paths_check() {
  local srcs=() pair src hits line rest
  for pair in "${LINKS[@]}"; do
    src="$HARNESS/${pair##*|}"
    [ -e "$src" ] || continue
    case " ${srcs[*]:-} " in *" $src "*) ;; *) srcs+=("$src") ;; esac
  done
  [ -d "$HARNESS/vscode" ] && srcs+=("$HARNESS/vscode")
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
  warn "заменить на \$HOME или ~"
  drift=$((drift + 1))
}

# Хуки tokensave в settings.json зовут бинарь голым именем в exec-форме
# (command + args): Claude Code ищет его в PATH, `tokensave doctor` такую запись
# принимает. Абсолютный путь пишет `tokensave install` — на машине, где tokensave
# лежит в другом месте, такие хуки молча не стартуют.
tokensave_hook_check() {
  local hook_bin
  hook_bin="$(grep -oE '"command": *"([^"]*/)?tokensave"' "$HARNESS/claude/settings.json" 2>/dev/null | head -1 | sed -E 's/.*"([^"]*)"$/\1/')" || true
  [ -z "$hook_bin" ] && return 0
  if [ "$hook_bin" = tokensave ]; then
    good "хуки tokensave в claude/settings.json зовут tokensave из PATH: $(command -v tokensave)"
    return 0
  fi
  if [ "$hook_bin" = "$(command -v tokensave)" ]; then
    good "хуки tokensave в claude/settings.json зовут $hook_bin"
    return 0
  fi
  bad "хуки tokensave в claude/settings.json зовут $hook_bin, а tokensave здесь: $(command -v tokensave) — поправить command в settings.json"
  drift=$((drift + 1))
}

# Бинаря нет — говорим, откуда взять и какую версию: state.toml переживает
# удаление бинаря, версия в нём — последняя стоявшая здесь. На новой машине
# файла нет, и подсказка обходится без версии.
tokensave_missing() {
  local want
  want="$(awk -F'"' '/^(last_installed_version|previous_version) *=/ && $2 != "" { print $2; exit }' "$HOME/.tokensave/state.toml" 2>/dev/null)" || true
  bad "tokensave — не найден: бинарь из релизов https://github.com/aovestdipaperino/tokensave в /usr/local/bin${want:+, здесь стояла $want}; tokensave install не запускать"
}

# `tokensave install` пишет поверх харнеса: свою MCP-запись вместо mcp-serve.sh
# (ловит mcp-sync --check), файлы правил — и заносит агента в installed_agents.
# После смены версии любая команда tokensave (и `tokensave init`) тихо
# переустанавливает этих агентов, и всё повторяется. Install-режим чистит оба
# следа: без агентов в state.toml tokensave больше ничего не переписывает.
# `tokensave uninstall` не годится — он же вырезает хуки из claude/settings.json.
tokensave_install_check() {
  local f agents state="$HOME/.tokensave/state.toml"
  f="$HOME/.claude/rules/tokensave.md"
  if [ -e "$f" ] && [ "$MODE" = "--check" ]; then
    bad "$f — след tokensave install: правила tokensave уже в skills"
    drift=$((drift + 1))
  elif [ -e "$f" ]; then
    mv "$f" "$f.bak-$STAMP"
    warn "$f — след tokensave install, сохранён как $(basename "$f").bak-$STAMP"
    fixed=$((fixed + 1))
  fi
  agents="$(awk '/^installed_agents/ { f = 1 }
    f { while (match($0, /"[^"]+"/)) { s = s substr($0, RSTART + 1, RLENGTH - 2) " "; $0 = substr($0, RSTART + RLENGTH) } }
    f && /]/ { exit }
    END { printf "%s", s }' "$state" 2>/dev/null)" || true
  [ -z "$agents" ] && return 0
  if [ "$MODE" = "--check" ]; then
    bad "tokensave install записал агентов: ${agents% } — после обновления tokensave перепишет их конфиги"
    warn "откат: ./install.sh, затем git -C $HARNESS diff claude/settings.json — tokensave пишет в него сквозь симлинк"
    drift=$((drift + 1)); return
  fi
  # Массив бывает многострочным: пропускаем до закрывающей скобки.
  awk '/^installed_agents/ { print "installed_agents = []"; skip = !/]/; next }
    skip { if (/]/) skip = 0; next }
    { print }' "$state" >"$state.tmp-$STAMP" && mv "$state.tmp-$STAMP" "$state"
  good "installed_agents очищен (было: ${agents% }) — tokensave больше не перепишет конфиги"
  fixed=$((fixed + 1))
}

# /model и /config пишут "model" в claude/settings.json через симлинк, и каждое
# переключение модели выглядело правкой харнеса. Clean-фильтр вырезает ключ при
# add/diff/status, файл на диске не трогает. .gitattributes только называет
# фильтр, команда живёт в .git/config — без неё смена модели снова в git status.
FILTER_CLEAN="jq --indent 2 'del(.model)'"
git_filter() {
  local have
  # Не git-копия харнеса (или git нет) — фильтровать нечего.
  git -C "$HARNESS" rev-parse --git-dir >/dev/null 2>&1 || return 0
  have="$(git -C "$HARNESS" config --get filter.nomodel.clean 2>/dev/null)" || true
  if [ "$have" = "$FILTER_CLEAN" ]; then
    good "git-фильтр nomodel: model из settings.json не попадает в git"; ok=$((ok + 1)); return
  fi
  if [ "$MODE" = "--check" ]; then
    warn "git-фильтр nomodel не задан — смена модели видна в git status, ./install.sh его задаст"
    drift=$((drift + 1)); return
  fi
  if ! command -v jq >/dev/null; then
    bad "jq не найден — git-фильтр nomodel не задать"; missing=$((missing + 1)); return
  fi
  git -C "$HARNESS" config filter.nomodel.clean "$FILTER_CLEAN"
  good "git-фильтр nomodel задан"; fixed=$((fixed + 1))
}

# MCP-серверы — один список mcp/servers.json. Claude держит их в
# ~/.claude.json (не симлинкуется); bin/mcp-sync.mjs сверяет или приводит его к списку.
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
  command -v node      >/dev/null && good "node $(node --version 2>/dev/null)" || bad "node — не найден: без него хуки и гарды харнесса молча не работают"
  command -v tokensave >/dev/null && good "tokensave: $(command -v tokensave)"               || tokensave_missing
  command -v tokensave >/dev/null && tokensave_hook_check
  tokensave_install_check
  # Playwright MCP не глобальный: его регистрируют в отдельных проектах (README),
  # пакет и браузер ставятся руками. Ревизию chromium называет playwright внутри
  # @playwright/mcp — у `npx playwright` она может быть другой.
  if command -v playwright-mcp >/dev/null; then
    good "playwright-mcp: $(command -v playwright-mcp)"
    pw_cli="$(npm root -g 2>/dev/null)/@playwright/mcp/node_modules/playwright/cli.js"
    pw_dir=$(node "$pw_cli" install --dry-run chromium 2>/dev/null | awk '/Install location/{print $3; exit}' || true)
    [ -n "$pw_dir" ] && [ -d "$pw_dir" ] && good "chromium для Playwright MCP: $pw_dir" || warn "chromium для Playwright MCP не скачан — node $pw_cli install chromium"
  else
    warn "playwright-mcp — не найден (нужен только проектам с Playwright MCP): npm i -g @playwright/mcp"
  fi
  command -v python3   >/dev/null && good "python3 $(python3 --version 2>&1 | awk '{print $2}')" || bad "python3 — не найден (нужен для ragsave)"
  [ -x "$RAG_HOME/venv/bin/python" ] && good "venv ragsave собран" || warn "venv ragsave не собран — ./install.sh --venv"
  # gitconfig ссылается на глобальные git-хуки tokensave (chain-repo-hook +
  # auto-init); без них git молча работает без хуков. Ставит их `tokensave
  # githooks on` — он пишет только в каталог хуков, в отличие от `tokensave install`.
  [ -x "$HOME/.config/git/hooks/post-checkout" ] && good "глобальные git-хуки tokensave на месте" || warn "глобальных git-хуков tokensave нет — tokensave githooks on"
  # Токен для MR берётся из ~/.git-credentials (credential.helper = store);
  # без файла GITLAB_TOKEN выйдет пустым — агент отдаст описание MR в чат.
  [ -f "$HOME/.git-credentials" ] && good "~/.git-credentials есть (источник GITLAB_TOKEN)" || warn "~/.git-credentials нет — GITLAB_TOKEN будет пустым, MR через API недоступен"
}

case "$MODE" in
  --check)
    say "Проверка симлинков харнеса ($HARNESS), $(personal_label):"
    for pair in "${LINKS[@]}"; do wanted "${pair%%|*}" && check_one "${pair%%|*}" "${pair##*|}"; done
    bashrc_hook
    git_filter
    vscode_links
    for pair in "${LOCALS[@]}"; do local_one "${pair%%|*}" "${pair##*|}"; done
    env_check
    backup_report
    backups_check
    projects_check
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
    say "Раскатка харнеса из $HARNESS, $(personal_label):"
    if [ "$PERSONAL" = 1 ] && [ ! -f "$PERSONAL_MARK" ]; then
      mkdir -p "$(dirname "$PERSONAL_MARK")" && : >"$PERSONAL_MARK"
    fi
    for pair in "${LINKS[@]}"; do wanted "${pair%%|*}" && link_one "${pair%%|*}" "${pair##*|}"; done
    bashrc_hook
    git_filter
    vscode_links
    for pair in "${LOCALS[@]}"; do local_one "${pair%%|*}" "${pair##*|}"; done
    shell_migrate .bashrc shell/bashrc shell/harness.bash
    shell_migrate .zshenv shell/zshenv
    gitconfig_migrate
    backup_report
    env_check
    backups_check
    projects_check
    mcp_sync
    externals
    say
    say "на месте: $ok, создано/починено: $fixed, нет источника: $missing"
    say
    say "Дальше: ./install.sh --venv. MCP-серверы правятся в mcp/servers.json."
    ;;
  *)
    say "Использование: ./install.sh [--personal|--check|--venv]"
    exit 2
    ;;
esac
