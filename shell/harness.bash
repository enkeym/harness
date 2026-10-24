# Ядро харнесса для интерактивного bash: install.sh кладёт сюда симлинк
# ~/.config/harness/bashrc и дописывает в свой ~/.bashrc машины блок
# `# >>> harness >>>`, который его подключает, — сам ~/.bashrc не заменяется.
# Личный shell/bashrc (./install.sh --personal) подключает его тем же блоком.

# ~/.local/bin — там лежит ragsave и прочие пользовательские бинари. Тот же
# путь добавляет ~/.profile, но он читается только login-шеллами, поэтому
# строка нужна здесь тоже — с проверкой, иначе PATH получал дубль.
case ":$PATH:" in
  *":$HOME/.local/bin:"*) ;;
  *) export PATH="$HOME/.local/bin:$PATH" ;;
esac

# BASH_ENV: bash сам подхватывает этот файл для неинтерактивных шеллов (в т.ч.
# Bash-тул харнесса Claude Code), минуя ранний return в ~/.bashrc. Секреты
# (GITLAB_TOKEN и т.п.) вынесены туда, а не сюда — см. ~/.bash_env.
export BASH_ENV="$HOME/.bash_env"

# Значения этой машины (GITLAB_HOST, RAGSAVE_HOME…) — вне git, в
# ~/.config/harness/env; install.sh создаёт его из local/env.example.
[ -f "$HOME/.config/harness/env" ] && . "$HOME/.config/harness/env"

# Ручной `tokensave init` / `ragsave init` — решение индексировать проект:
# второй индекс project-init.sh достраивает в фоне и сам печатает об этом
# строку. Каталог — последний аргумент-каталог после init, иначе текущий.
# Тот же код — в shell/zshenv.
__project_init() {
  local dir="$PWD" arg
  shift
  for arg in "$@"; do [ -d "$arg" ] && dir="$arg"; done
  [ -x "$HOME/.ai-hooks/bin/project-init.sh" ] && "$HOME/.ai-hooks/bin/project-init.sh" --detach "$dir"
  return 0
}
tokensave() { command tokensave "$@" || return; [ "${1:-}" = init ] && __project_init "$@"; return 0; }
ragsave() { command ragsave "$@" || return; [ "${1:-}" = init ] && __project_init "$@"; return 0; }
