"""Пути, константы и определение корня проекта.

Единая точка истины для остальных модулей: где лежит индекс, какая модель
эмбеддингов, что считать текстовым файлом.
"""

from __future__ import annotations

import os
import re
import subprocess
from dataclasses import dataclass
from pathlib import Path

# Каталог индекса внутри проекта — парный к .tokensave/
INDEX_DIR = ".ragsave"
DB_NAME = "rag.db"
LOCK_NAME = ".sync.lock"
AGAIN_NAME = ".sync.again"
# Лог фонового синка и отказ от него пишет и читает ai-hooks/bin/ragsave-sync.sh:
# имена правятся вместе.
SYNC_LOG_NAME = "sync.log"
DISABLE_MARK = ".ragsave-disable"

# Индекс tokensave — по нему помечаем, что уже покрыто структурным слоем
TOKENSAVE_DB = os.path.join(".tokensave", "tokensave.db")

# Модель эмбеддингов. multilingual-e5-large: 1024 dim, 2.24GB — лучшее
# качество среди multilingual в fastembed, уверенно держит русский.
# Переключается через RAGSAVE_MODEL на что-то легче, если понадобится
# (paraphrase-multilingual-MiniLM-L12-v2 — 384 dim, 0.22GB, заметно быстрее).
# Размерность вектора у моделей разная, поэтому смена модели требует
# перестроить индекс: ragsave reindex.
_MODELS: dict[str, int] = {
    "sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2": 384,
    "sentence-transformers/paraphrase-multilingual-mpnet-base-v2": 768,
    "sentence-transformers/all-MiniLM-L6-v2": 384,
    "intfloat/multilingual-e5-large": 1024,
    "BAAI/bge-small-en-v1.5": 384,
}
DEFAULT_MODEL = "intfloat/multilingual-e5-large"
EMBED_MODEL = os.environ.get("RAGSAVE_MODEL", DEFAULT_MODEL)
EMBED_DIM = _MODELS.get(EMBED_MODEL, 384)
MODEL_CACHE = os.environ.get(
    "RAGSAVE_MODEL_CACHE", str(Path.home() / ".rag-mcp" / "models")
)


def _env_int(name: str, default: int | None) -> int | None:
    raw = os.environ.get(name, "").strip()
    if not raw:
        return default
    try:
        return int(raw)
    except ValueError:
        return default


# Сколько фрагментов уходит в модель за один вызов ONNX. Крупнее — эффективнее
# матричные операции, но реже обновляется прогресс и выше пик памяти.
EMBED_BATCH = max(1, _env_int("RAGSAVE_BATCH", 32) or 32)

# Число процессов-воркеров модели (data-parallel в fastembed). Каждый воркер
# держит свою копию модели в памяти (~3 GB для e5-large), поэтому по умолчанию
# один процесс: ONNX и так параллелит одну инференцию по ядрам. 0 — по числу
# ядер, N — столько воркеров; имеет смысл только при большом запасе RAM.
EMBED_PARALLEL = _env_int("RAGSAVE_PARALLEL", None)

# Потоки ONNX внутри одной инференции; пусто — выбор onnxruntime.
EMBED_THREADS = _env_int("RAGSAVE_THREADS", None)

# Сколько секунд ждать, если БД занята другим соединением (WAL: писатель один).
DB_BUSY_TIMEOUT = 60.0

# Чанкинг: мягкий лимит символов на чанк (~400 токенов) и перекрытие строками.
CHUNK_CHARS = 1600
CHUNK_OVERLAP_LINES = 3

# Файлы крупнее — пропускаем: лок-файлы, дампы, минифицированный js.
# Для семантического поиска они бесполезны, а индекс раздувают сильно.
MAX_FILE_BYTES = 1_000_000

# Каталоги, которые не обходим в не-git проектах (в git .gitignore решает сам).
SKIP_DIRS = {
    ".git", ".svn", ".hg", "node_modules", "__pycache__", ".venv", "venv",
    "env", ".env.d", "dist", "build", "out", "target", ".next", ".nuxt",
    ".cache", ".turbo", ".parcel-cache", "coverage", ".pytest_cache",
    ".mypy_cache", ".ruff_cache", ".gradle", ".idea", ".vscode",
    INDEX_DIR, ".tokensave",
}

# Бинарные/шумные расширения — отсекаем до чтения содержимого.
SKIP_EXTS = {
    ".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".bmp", ".tiff", ".avif",
    ".svg", ".pdf", ".zip", ".gz", ".tar", ".bz2", ".xz", ".7z", ".rar",
    ".mp3", ".mp4", ".avi", ".mov", ".wav", ".webm", ".flac", ".ogg",
    ".woff", ".woff2", ".ttf", ".otf", ".eot",
    ".so", ".dll", ".dylib", ".exe", ".bin", ".o", ".a", ".class", ".jar",
    ".pyc", ".pyo", ".wasm", ".node", ".db", ".sqlite", ".sqlite3",
    ".lock", ".map", ".min.js", ".min.css", ".pack", ".idx",
}

# Имена файлов, которые не несут смысла для поиска.
SKIP_NAMES = {
    "package-lock.json", "yarn.lock", "pnpm-lock.yaml", "bun.lockb",
    "poetry.lock", "Pipfile.lock", "composer.lock", "Cargo.lock",
    "go.sum", "gemfile.lock", ".DS_Store",
}

# Хранилища секретов. В git-репозитории они обычно в .gitignore и до сюда не
# доходят, но запасной обход каталогов (не-git проект) их бы проиндексировал —
# и rag_search вернул бы значение токена прямо в контекст агента. Индекс живёт
# дольше сессии, поэтому фильтруем по имени, а не полагаемся на .gitignore.
# Примеры и шаблоны не секреты: в них имена переменных без значений.
# Список продублирован в ai-hooks/security-core.mjs:SECRET_FILE_RE — правятся вместе.
SECRET_NAME_RE = re.compile(
    r"""(?xi)
    ^(
        \.env([.-](?!example$|sample$|template$|dist$|tpl$)[\w-]+)*   # .env, .env.local, .env-prod
      | \.envrc
      | \.?(npmrc|pypirc|netrc|pgpass)
      | id_(rsa|dsa|ecdsa|ed25519)([_-][\w-]+)?                  # и id_ed25519_github, без .pub
      | \.?(credentials|auth|secrets?|service-account[\w-]*)\.json  # и .credentials.json Claude
      | \.?(credentials|secrets?)\.ya?ml
      | \.git-credentials
      | [\w.-]*\.(tfstate(\.backup)?|tfvars(\.json)?)             # Terraform state и переменные
      | [\w.-]*(private|secret)[\w.-]*\.key
      | (server|tls|ssl|client|master)\.key                      # master.key — Rails
    )$
    """
)

SECRET_EXTS = {".pem", ".p12", ".pfx", ".keystore", ".jks"}

# Учётные данные CLI: имя файла общее (`config`, `config.json`), секретом его
# делает каталог. Пары (каталог, имя).
SECRET_IN_DIR = {
    (".aws", "credentials"),
    (".docker", "config.json"),
    (".kube", "config"),
    ("gh", "hosts.yml"), ("gh", "hosts.yaml"),
    ("glab-cli", "config.yml"), ("glab-cli", "config.yaml"),
}


def is_secret_name(path: Path) -> bool:
    """Похоже ли имя файла на хранилище секретов."""
    return (
        bool(SECRET_NAME_RE.match(path.name))
        or path.suffix.lower() in SECRET_EXTS
        or (path.parent.name, path.name) in SECRET_IN_DIR
    )


@dataclass(frozen=True)
class ProjectPaths:
    """Пути индекса для конкретного проекта."""

    root: Path

    @property
    def index_dir(self) -> Path:
        return self.root / INDEX_DIR

    @property
    def db(self) -> Path:
        return self.index_dir / DB_NAME

    @property
    def lock(self) -> Path:
        return self.index_dir / LOCK_NAME

    @property
    def again_mark(self) -> Path:
        return self.index_dir / AGAIN_NAME

    @property
    def sync_log(self) -> Path:
        return self.index_dir / SYNC_LOG_NAME

    @property
    def disable_mark(self) -> Path:
        return self.root / DISABLE_MARK

    @property
    def tokensave_db(self) -> Path:
        return self.root / TOKENSAVE_DB

    def ensure_dir(self) -> None:
        self.index_dir.mkdir(parents=True, exist_ok=True)


def find_project_root(start: str | os.PathLike[str] | None = None) -> Path | None:
    """Корень проекта: git-репозиторий, иначе ближайший каталог с маркером.

    Возвращает None для $HOME и вне проекта — индексировать домашний каталог
    целиком мы не хотим никогда.
    """
    begin = Path(start or os.getcwd()).resolve()
    if begin.is_file():
        begin = begin.parent

    home = Path.home().resolve()

    try:
        out = subprocess.run(
            ["git", "-C", str(begin), "rev-parse", "--show-toplevel"],
            capture_output=True, text=True, timeout=5, check=False,
        )
        if out.returncode == 0:
            root = Path(out.stdout.strip()).resolve()
            return None if root == home else root
    except (OSError, subprocess.SubprocessError):
        pass

    markers = (".tokensave", INDEX_DIR, "package.json", "pyproject.toml",
               "Cargo.toml", "go.mod", "pom.xml", ".git")
    current = begin
    while current != current.parent:
        if current == home:
            return None
        if any((current / m).exists() for m in markers):
            return current
        current = current.parent
    return None


def is_text_by_name(path: Path) -> bool:
    """Дешёвая проверка без обращения к диску: расширение и имя файла."""
    if path.name in SKIP_NAMES or path.name.lower() in SKIP_NAMES:
        return False
    if is_secret_name(path):
        return False
    suffixes = "".join(path.suffixes[-2:]).lower()
    return not (path.suffix.lower() in SKIP_EXTS or suffixes in SKIP_EXTS)


def is_text_by_content(path: Path, size: int | None = None) -> bool:
    """Проверка по содержимому: размер и null-байт в первых 8 КБ."""
    try:
        if (size if size is not None else path.stat().st_size) > MAX_FILE_BYTES:
            return False
        with path.open("rb") as fh:
            return b"\0" not in fh.read(8192)
    except OSError:
        return False


def is_probably_text(path: Path) -> bool:
    """Текстовый ли файл: по расширению/имени, затем по null-байту в начале."""
    return is_text_by_name(path) and is_text_by_content(path)
