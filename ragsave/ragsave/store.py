"""Хранилище индекса: SQLite + sqlite-vec + FTS5.

Один файл .ragsave/rag.db на проект — ни сервера, ни демона, как и у tokensave.

Поиск гибридный: векторный (смысловая близость) и полнотекстовый (точные
слова) выполняются независимо, результаты сливаются по RRF. Чистый вектор
плохо находит точные идентификаторы — имя ключа в yaml, название переменной
окружения; чистый BM25 не понимает переформулировок. Вместе они закрывают
слабости друг друга.
"""

from __future__ import annotations

import re
import sqlite3
import time
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import Iterator

import sqlite_vec

from . import config

SCHEMA_VERSION = "1"

# Константа сглаживания RRF. 60 — значение из исходной статьи Cormack et al.;
# гасит вклад низких позиций, оставляя верхушки обоих списков значимыми.
RRF_K = 60

_FTS_TOKEN = re.compile(r"[^\wЀ-ӿ]+", re.UNICODE)


@dataclass(frozen=True)
class SearchHit:
    """Найденный фрагмент."""

    path: str
    start_line: int
    end_line: int
    text: str
    score: float
    in_tokensave: bool


@dataclass(frozen=True)
class FileRecord:
    """Состояние проиндексированного файла — для инкрементальной досборки."""

    path: str
    hash: str
    size: int
    mtime: float


class Store:
    """Индекс одного проекта. Использовать как контекстный менеджер."""

    def __init__(self, db_path: Path, dim: int | None = None) -> None:
        self._path = db_path
        self._dim = dim or config.EMBED_DIM
        self._db: sqlite3.Connection | None = None

    def __enter__(self) -> "Store":
        self.open()
        return self

    def __exit__(self, *exc: object) -> None:
        self.close()

    def open(self) -> None:
        self._path.parent.mkdir(parents=True, exist_ok=True)
        # Autocommit: транзакции открываются явно через transaction(). Неявная
        # транзакция python-sqlite держала бы блокировку записи с первого
        # INSERT до commit — то есть всё время, пока модель считает следующий
        # батч, и любой второй писатель падал бы с «database is locked».
        db = sqlite3.connect(
            str(self._path), timeout=config.DB_BUSY_TIMEOUT, isolation_level=None
        )
        db.row_factory = sqlite3.Row
        db.enable_load_extension(True)
        sqlite_vec.load(db)
        db.enable_load_extension(False)
        # Смена журнала — запись; на уже WAL-базе она не нужна и лишь
        # столкнулась бы с идущей индексацией.
        if db.execute("PRAGMA journal_mode").fetchone()[0].lower() != "wal":
            db.execute("PRAGMA journal_mode=WAL")
        db.execute("PRAGMA synchronous=NORMAL")
        self._db = db
        if not self._schema_exists():
            self._create_schema()

    def _schema_exists(self) -> bool:
        row = self.conn.execute(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name='chunk_cache'"
        ).fetchone()
        return row is not None

    @contextmanager
    def transaction(self) -> Iterator[None]:
        """Короткая транзакция записи; BEGIN IMMEDIATE берёт замок сразу."""
        db = self.conn
        db.execute("BEGIN IMMEDIATE")
        try:
            yield
        except BaseException:
            db.execute("ROLLBACK")
            raise
        db.execute("COMMIT")

    def close(self) -> None:
        if self._db is not None:
            self._db.close()
            self._db = None

    @property
    def conn(self) -> sqlite3.Connection:
        if self._db is None:
            raise RuntimeError("Store не открыт: вызовите open() или используйте with")
        return self._db

    def _create_schema(self) -> None:
        db = self.conn
        db.executescript(
            f"""
            CREATE TABLE IF NOT EXISTS meta(
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS files(
                path TEXT PRIMARY KEY,
                hash TEXT NOT NULL,
                size INTEGER NOT NULL,
                mtime REAL NOT NULL,
                chunks INTEGER NOT NULL DEFAULT 0,
                in_tokensave INTEGER NOT NULL DEFAULT 0,
                indexed_at REAL NOT NULL
            );
            CREATE TABLE IF NOT EXISTS chunks(
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                path TEXT NOT NULL,
                start_line INTEGER NOT NULL,
                end_line INTEGER NOT NULL,
                text TEXT NOT NULL,
                in_tokensave INTEGER NOT NULL DEFAULT 0
            );
            CREATE INDEX IF NOT EXISTS idx_chunks_path ON chunks(path);
            CREATE VIRTUAL TABLE IF NOT EXISTS vec_chunks USING vec0(
                chunk_id INTEGER PRIMARY KEY,
                embedding FLOAT[{self._dim}]
            );
            CREATE VIRTUAL TABLE IF NOT EXISTS fts_chunks USING fts5(
                text,
                tokenize='unicode61 remove_diacritics 2'
            );
            -- Кеш по содержимому: ключ — sha256 файла, а не его путь. Смена
            -- ветки возвращает прежнее содержимое, и такой файл восстанавливается
            -- отсюда, не проходя через модель повторно.
            CREATE TABLE IF NOT EXISTS chunk_cache(
                content_hash TEXT NOT NULL,
                seq INTEGER NOT NULL,
                start_line INTEGER NOT NULL,
                end_line INTEGER NOT NULL,
                text TEXT NOT NULL,
                embedding BLOB NOT NULL,
                last_used REAL NOT NULL,
                PRIMARY KEY(content_hash, seq)
            );
            CREATE INDEX IF NOT EXISTS idx_cache_used ON chunk_cache(last_used);
            """
        )

    # ---------- метаданные ----------

    def get_meta(self, key: str) -> str | None:
        row = self.conn.execute("SELECT value FROM meta WHERE key=?", (key,)).fetchone()
        return row["value"] if row else None

    def set_meta(self, key: str, value: str) -> None:
        self.conn.execute(
            "INSERT INTO meta(key,value) VALUES(?,?) "
            "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            (key, value),
        )

    def stamp(self, model: str, dim: int) -> None:
        with self.transaction():
            self.set_meta("schema_version", SCHEMA_VERSION)
            self.set_meta("model", model)
            self.set_meta("dim", str(dim))

    def model_mismatch(self, model: str) -> str | None:
        """Сообщение о несовместимости индекса с текущей моделью, иначе None."""
        stored = self.get_meta("model")
        if stored is None:
            return None
        if stored != model:
            return (
                f"индекс построен моделью {stored}, сейчас выбрана {model}. "
                f"Размерности векторов различаются — выполните: ragsave reindex"
            )
        return None

    # ---------- состояние файлов ----------

    def known_files(self) -> dict[str, FileRecord]:
        rows = self.conn.execute("SELECT path,hash,size,mtime FROM files").fetchall()
        return {
            row["path"]: FileRecord(
                path=row["path"], hash=row["hash"], size=row["size"], mtime=row["mtime"]
            )
            for row in rows
        }

    def drop_file(self, path: str) -> None:
        """Удалить файл и все его фрагменты из индекса."""
        db = self.conn
        ids = [
            row["id"]
            for row in db.execute("SELECT id FROM chunks WHERE path=?", (path,))
        ]
        if ids:
            marks = ",".join("?" * len(ids))
            db.execute(f"DELETE FROM vec_chunks WHERE chunk_id IN ({marks})", ids)
            db.execute(f"DELETE FROM fts_chunks WHERE rowid IN ({marks})", ids)
            db.execute("DELETE FROM chunks WHERE path=?", (path,))
        db.execute("DELETE FROM files WHERE path=?", (path,))

    def add_file(
        self,
        path: str,
        record: FileRecord,
        chunks: list[tuple[str, int, int]],
        vectors: list[list[float]],
        in_tokensave: bool,
    ) -> None:
        """Записать файл с фрагментами и векторами. Прежняя версия удаляется."""
        db = self.conn
        self.drop_file(path)
        flag = 1 if in_tokensave else 0

        for (text, start, end), vector in zip(chunks, vectors):
            cursor = db.execute(
                "INSERT INTO chunks(path,start_line,end_line,text,in_tokensave) "
                "VALUES(?,?,?,?,?)",
                (path, start, end, text, flag),
            )
            chunk_id = cursor.lastrowid
            db.execute(
                "INSERT INTO vec_chunks(chunk_id,embedding) VALUES(?,?)",
                (chunk_id, _as_blob(vector)),
            )
            # Путь идёт и в полнотекстовый индекс: запрос со словом «mail»
            # должен находить config/mail.yaml, даже если внутри файла этого
            # слова нет. Показываем всё равно только сам фрагмент.
            db.execute(
                "INSERT INTO fts_chunks(rowid,text) VALUES(?,?)",
                (chunk_id, f"{path.replace('/', ' ')}\n{text}"),
            )

        db.execute(
            "INSERT INTO files(path,hash,size,mtime,chunks,in_tokensave,indexed_at) "
            "VALUES(?,?,?,?,?,?,?)",
            (path, record.hash, record.size, record.mtime, len(chunks), flag, time.time()),
        )

    def touch_file(self, record: FileRecord) -> None:
        """Обновить размер и mtime файла с прежним содержимым.

        Без этого файл, тронутый git checkout, хешировался бы на каждом синке.
        """
        self.conn.execute(
            "UPDATE files SET size=?, mtime=? WHERE path=?",
            (record.size, record.mtime, record.path),
        )

    def commit(self) -> None:
        """Завершить открытую транзакцию; вне transaction() — ничего не делает."""
        if self.conn.in_transaction:
            self.conn.execute("COMMIT")

    # ---------- кеш по содержимому ----------

    def cached_chunks(
        self, content_hash: str
    ) -> tuple[list[tuple[str, int, int]], list[bytes]] | None:
        """Готовые фрагменты и векторы для такого содержимого, если считались ранее.

        Позволяет переключение веток без обращения к модели: содержимое,
        уже встречавшееся в любой ветке, восстанавливается как есть.
        """
        rows = self.conn.execute(
            "SELECT start_line,end_line,text,embedding FROM chunk_cache "
            "WHERE content_hash=? ORDER BY seq",
            (content_hash,),
        ).fetchall()
        if not rows:
            return None
        chunks = [(row["text"], row["start_line"], row["end_line"]) for row in rows]
        vectors = [row["embedding"] for row in rows]
        return chunks, vectors

    def put_cache(
        self,
        content_hash: str,
        chunks: list[tuple[str, int, int]],
        vectors: list[list[float] | bytes],
    ) -> None:
        """Запомнить результат вычисления для этого содержимого."""
        now = time.time()
        self.conn.executemany(
            "INSERT INTO chunk_cache"
            "(content_hash,seq,start_line,end_line,text,embedding,last_used) "
            "VALUES(?,?,?,?,?,?,?) ON CONFLICT(content_hash,seq) DO UPDATE SET "
            "last_used=excluded.last_used",
            [
                (content_hash, seq, start, end, text, _as_blob(vector), now)
                for seq, ((text, start, end), vector) in enumerate(zip(chunks, vectors))
            ],
        )

    def touch_cache(self, content_hash: str) -> None:
        """Отметить попадание — по этой отметке кеш чистится."""
        self.conn.execute(
            "UPDATE chunk_cache SET last_used=? WHERE content_hash=?",
            (time.time(), content_hash),
        )

    def forget_cache(self, content_hash: str) -> None:
        """Стереть содержимое из кеша сразу, не дожидаясь gc_cache."""
        self.conn.execute("DELETE FROM chunk_cache WHERE content_hash=?", (content_hash,))

    def gc_cache(
        self,
        max_age_days: float = 45.0,
        max_files: int = 20_000,
        max_chunk_ratio: float = 20.0,
        min_cached_chunks: int = 2_000,
    ) -> int:
        """Убрать давно не использованные записи. Возвращает число удалённых.

        Кеш растёт от каждой уникальной версии файла, поэтому без чистки он
        накапливал бы все содержимое всех веток за всё время.

        Три предела, и третий не лишний. Возраст и количество не спасают от
        разового всплеска: если проект однажды проиндексировали шире, чем надо
        (например, корневой репозиторий затянул соседние каталоги), кеш свежий
        и по числу версий далеко до общего лимита — а на диске сотни мегабайт,
        и сами они не уйдут никогда.

        Мера здесь — не абсолютный размер, а отношение кеша к живому индексу.
        Абсолютный порог одинаково неверен для обоих краёв: у большого проекта
        он режет полезный кеш, у маленького не срабатывает вовсе. Кеш вдесятеро
        больше индекса — это версии, которых в проекте давно нет.
        """
        db = self.conn
        cutoff = time.time() - max_age_days * 86_400
        removed = db.execute(
            "DELETE FROM chunk_cache WHERE last_used < ?", (cutoff,)
        ).rowcount

        surplus = db.execute(
            "SELECT COUNT(DISTINCT content_hash) AS n FROM chunk_cache"
        ).fetchone()["n"] - max_files
        if surplus > 0:
            removed += db.execute(
                "DELETE FROM chunk_cache WHERE content_hash IN ("
                "  SELECT content_hash FROM chunk_cache"
                "  GROUP BY content_hash ORDER BY MAX(last_used) ASC LIMIT ?"
                ")",
                (surplus,),
            ).rowcount

        removed += self._gc_oversized_cache(max_chunk_ratio, min_cached_chunks)
        return removed

    def _gc_oversized_cache(self, max_ratio: float, min_chunks: int) -> int:
        """Срезать кеш, разросшийся относительно живого индекса, и сжать файл.

        Режем самые давно не использованные версии целиком (частично удалённая
        версия бесполезна: восстановление файла из кеша требует всех его
        фрагментов). VACUUM обязателен — без него удаление строк не меняет
        размер файла, SQLite оставляет освободившиеся страницы себе.
        """
        if max_ratio <= 0:
            return 0

        db = self.conn
        live = db.execute("SELECT COUNT(*) AS n FROM chunks").fetchone()["n"]
        cached = db.execute("SELECT COUNT(*) AS n FROM chunk_cache").fetchone()["n"]
        target = max(min_chunks, int(live * max_ratio))
        if cached <= target:
            return 0

        # Идём от самых старых версий, пока не уложимся в цель. Шаг — половина
        # избытка по версиям, чтобы не делать десятки проходов на большом кеше.
        removed = 0
        for _ in range(12):
            versions = db.execute(
                "SELECT COUNT(DISTINCT content_hash) AS n FROM chunk_cache"
            ).fetchone()["n"]
            if versions == 0:
                break
            step = max(1, versions // 2)
            removed += db.execute(
                "DELETE FROM chunk_cache WHERE content_hash IN ("
                "  SELECT content_hash FROM chunk_cache"
                "  GROUP BY content_hash ORDER BY MAX(last_used) ASC LIMIT ?"
                ")",
                (step,),
            ).rowcount
            db.commit()
            if db.execute("SELECT COUNT(*) AS n FROM chunk_cache").fetchone()["n"] <= target:
                break

        if removed:
            db.execute("VACUUM")
        return removed

    def cache_stats(self) -> tuple[int, int]:
        """(уникальных версий файлов в кеше, всего фрагментов)."""
        row = self.conn.execute(
            "SELECT COUNT(DISTINCT content_hash) AS files, COUNT(*) AS chunks "
            "FROM chunk_cache"
        ).fetchone()
        return row["files"], row["chunks"]

    # ---------- поиск ----------

    def search(
        self,
        query_vector: list[float],
        query_text: str,
        limit: int = 8,
        candidates: int = 40,
        path_include: list[str] | None = None,
        path_exclude: list[str] | None = None,
        only_outside_tokensave: bool = False,
    ) -> list[SearchHit]:
        """Гибридный поиск: вектор + FTS, слияние по RRF."""
        vector_ranks = self._vector_ranks(query_vector, candidates)
        text_ranks = self._fts_ranks(query_text, candidates)

        fused: dict[int, float] = {}
        for ranking in (vector_ranks, text_ranks):
            for position, chunk_id in enumerate(ranking, start=1):
                fused[chunk_id] = fused.get(chunk_id, 0.0) + 1.0 / (RRF_K + position)

        if not fused:
            return []

        ordered = sorted(fused.items(), key=lambda item: item[1], reverse=True)
        hits: list[SearchHit] = []
        for chunk_id, score in ordered:
            row = self.conn.execute(
                "SELECT path,start_line,end_line,text,in_tokensave "
                "FROM chunks WHERE id=?",
                (chunk_id,),
            ).fetchone()
            if row is None:
                continue
            if not _passes_filters(
                row["path"], path_include, path_exclude,
                bool(row["in_tokensave"]), only_outside_tokensave,
            ):
                continue
            hits.append(
                SearchHit(
                    path=row["path"],
                    start_line=row["start_line"],
                    end_line=row["end_line"],
                    text=row["text"],
                    score=score,
                    in_tokensave=bool(row["in_tokensave"]),
                )
            )
            if len(hits) >= limit:
                break
        return hits

    def _vector_ranks(self, vector: list[float], k: int) -> list[int]:
        rows = self.conn.execute(
            "SELECT chunk_id FROM vec_chunks "
            "WHERE embedding MATCH ? AND k = ? ORDER BY distance",
            (sqlite_vec.serialize_float32(vector), k),
        ).fetchall()
        return [row["chunk_id"] for row in rows]

    def _fts_ranks(self, query_text: str, k: int) -> list[int]:
        expression = _fts_query(query_text)
        if not expression:
            return []
        try:
            rows = self.conn.execute(
                "SELECT rowid FROM fts_chunks WHERE fts_chunks MATCH ? "
                "ORDER BY rank LIMIT ?",
                (expression, k),
            ).fetchall()
        except sqlite3.OperationalError:
            # Нераспарсенный запрос не должен ронять поиск — вектор отработает сам.
            return []
        return [row["rowid"] for row in rows]

    # ---------- статистика ----------

    def stats(self) -> dict[str, object]:
        db = self.conn
        files = db.execute("SELECT COUNT(*) AS n FROM files").fetchone()["n"]
        chunks = db.execute("SELECT COUNT(*) AS n FROM chunks").fetchone()["n"]
        covered = db.execute(
            "SELECT COUNT(*) AS n FROM files WHERE in_tokensave=1"
        ).fetchone()["n"]
        size = self._path.stat().st_size if self._path.exists() else 0
        cached_files, cached_chunks = self.cache_stats()
        return {
            "db": str(self._path),
            "files": files,
            "chunks": chunks,
            "files_in_tokensave": covered,
            "files_outside_tokensave": files - covered,
            "db_size_mb": round(size / 1_048_576, 2),
            "model": self.get_meta("model"),
            "dim": self.get_meta("dim"),
            "cache_versions": cached_files,
            "cache_chunks": cached_chunks,
        }


def _as_blob(vector: list[float] | bytes) -> bytes:
    """Вектор в бинарном виде. Из кеша он приходит уже сериализованным."""
    if isinstance(vector, (bytes, bytearray, memoryview)):
        return bytes(vector)
    return sqlite_vec.serialize_float32(vector)


def _fts_query(text: str) -> str:
    """Собрать безопасное FTS5-выражение из произвольного запроса.

    Слова экранируем кавычками и соединяем OR: пользовательский текст может
    содержать `-`, `*`, `:` — служебные символы FTS5, которые иначе роняют
    парсер синтаксической ошибкой.
    """
    words = [word for word in _FTS_TOKEN.split(text) if len(word) > 1]
    if not words:
        return ""
    return " OR ".join(f'"{word}"' for word in words[:24])


def _passes_filters(
    path: str,
    include: list[str] | None,
    exclude: list[str] | None,
    in_tokensave: bool,
    only_outside: bool,
) -> bool:
    if only_outside and in_tokensave:
        return False
    if exclude and any(fragment in path for fragment in exclude):
        return False
    if include and not any(fragment in path for fragment in include):
        return False
    return True
