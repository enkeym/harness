#!/usr/bin/env bash
set -euo pipefail
HARNESS="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RAG_HOME="${RAGSAVE_HOME:-$HOME/.rag-mcp}"
say() { printf "%s\n" "$*"; }
good() { say "$*"; }
warn() { say "$*" >&2; }
bad() { warn "$*"; }
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

build_venv
