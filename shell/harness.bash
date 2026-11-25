case ":$PATH:" in
  *":$HOME/.local/bin:"*) ;;
  *) export PATH="$HOME/.local/bin:$PATH" ;;
esac

export BASH_ENV="${BASH_ENV:-$HOME/.config/harness/bashrc}"

if [ -f "$HOME/.config/harness/env" ]; then
  case $- in
    *a*) . "$HOME/.config/harness/env" ;;
    *) set -a; . "$HOME/.config/harness/env"; set +a ;;
  esac
fi
