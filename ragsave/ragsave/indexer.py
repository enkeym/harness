"""Обход проекта и наполнение индекса.

Инкрементальность в два уровня: файл с прежними размером и mtime не читается
вовсе, файл с новым mtime, но прежним sha256 не пересчитывается. Исчезнувшие
файлы удаляются. Полный проход большого репозитория стоит минуты, повторный
без изменений — доли секунды, поэтому синк можно вешать на завершение ответа
агента.

Проход разбит на две фазы. Сканирование (stat, чтение, хеш, чанкинг) идёт в
отдельном потоке и никогда не ждёт модели; главный поток в это время решает
судьбу каждого файла (пропустить, восстановить из кеша, поставить в очередь
на эмбеддинг) и пишет в БД. Затем все фрагменты, которым нужна модель, уходят
в неё одним потоком — векторы возвращаются по мере готовности батчей и сразу
пишутся в индекс короткими транзакциями.

Каждый файл помечается флагом in_tokensave: покрыт ли он структурным
индексом. Флаг не исключает файл из поиска — он позволяет спросить отдельно
«что есть только здесь и нет в графе кода» (доки, конфиги, миграции).
"""

from __future__ import annotations

import fcntl
import hashlib
import json
import os
import queue
import sqlite3
import subprocess
import sys
import threading
import time
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Iterator

from . import config
from .chunker import Chunk, chunk_text
from .config import ProjectPaths
from .embedder import Embedder
from .store import FileRecord, Store

# Глубина очереди между сканером и главным потоком: сканер читает файлы
# быстрее, чем главный поток восстанавливает их из кеша, и без предела
# держал бы содержимое всего проекта в памяти дважды.
SCAN_QUEUE = 64

# Конкурентный запуск — штатный пропуск, а не отказ: cli выходит с EXIT_BUSY,
# по этому коду log-error.sh и не пишет запись.
LOCK_HELD_MESSAGE = "another sync is already in progress"


class SyncInProgress(RuntimeError):
    """Другой процесс уже индексирует этот проект."""


@dataclass
class IndexReport:
    """Итог прохода индексации."""

    added: int = 0
    updated: int = 0
    removed: int = 0
    skipped: int = 0
    chunks: int = 0
    errors: int = 0
    restored: int = 0
    cache_pruned: int = 0
    embed_seconds: float = 0.0

    def as_dict(self) -> dict[str, int | float]:
        return {
            "added": self.added,
            "updated": self.updated,
            "removed": self.removed,
            "unchanged": self.skipped,
            "restored_from_cache": self.restored,
            "chunks_written": self.chunks,
            "cache_pruned": self.cache_pruned,
            "errors": self.errors,
            "embed_seconds": round(self.embed_seconds, 1),
        }


@dataclass(frozen=True)
class Scanned:
    """Результат сканирования одного файла (см. status)."""

    status: str  # unchanged | touched | binary | empty | error | changed
    relative: str
    record: FileRecord | None = None
    chunks: list[Chunk] | None = None


@contextmanager
def sync_lock(lock_path: Path, wait: float = 0.0) -> Iterator[None]:
    """Замок на проект: тот же файл, что раньше держал flock в хуке.

    flock(2) снимается ядром при закрытии дескриптора, поэтому упавший процесс
    замок не оставляет. В файл пишется PID и время — для сообщения тому, кто
    пришёл вторым.
    """
    lock_path.parent.mkdir(parents=True, exist_ok=True)
    handle = lock_path.open("a+", encoding="utf-8")
    try:
        deadline = time.monotonic() + wait
        while True:
            try:
                fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except BlockingIOError:
                if time.monotonic() >= deadline:
                    handle.seek(0)
                    holder = handle.read().strip() or "неизвестный процесс"
                    raise SyncInProgress(
                        f"{LOCK_HELD_MESSAGE} ({holder}); "
                        f"ход работы — в {lock_path.parent / 'sync.log'}"
                    ) from None
                time.sleep(0.5)
        handle.seek(0)
        handle.truncate()
        handle.write(f"PID {os.getpid()}, начат {time.strftime('%Y-%m-%d %H:%M:%S')}")
        handle.flush()
        yield
    finally:
        handle.close()


def lock_holder(lock_path: Path) -> str | None:
    """Кто сейчас держит замок проекта; None — никто.

    Проба разделяемая: PID в файл не пишет, а хук, пришедший в то же мгновение,
    получит «занято» только на время самой пробы.
    """
    try:
        handle = lock_path.open("r", encoding="utf-8")
    except FileNotFoundError:
        return None
    with handle:
        try:
            fcntl.flock(handle.fileno(), fcntl.LOCK_SH | fcntl.LOCK_NB)
        except BlockingIOError:
            return handle.read().strip() or "неизвестный процесс"
        fcntl.flock(handle.fileno(), fcntl.LOCK_UN)
        return None


def last_sync(log_path: Path) -> dict[str, object] | None:
    """Итог последнего фонового синка по его логу: время и отчёт либо ошибка.

    Отчёт — JSON, который `ragsave sync` печатает последним; нет его — синк
    упал, и причина стоит в последней строке лога.
    """
    try:
        text = log_path.read_text(encoding="utf-8", errors="replace")
        mtime = log_path.stat().st_mtime
    except OSError:
        return None
    at = time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(mtime))
    try:
        report = json.loads(text[text.rfind("\n{") + 1:])
    except ValueError:
        lines = [line for line in text.splitlines() if line.strip()]
        return {"at": at, "error": lines[-1][-200:] if lines else "пустой лог"}
    return {"at": at, "report": report}


def sync_state(paths: ProjectPaths) -> dict[str, object]:
    """Состояние автосинка: без него выключенный хук две недели выглядел живым."""
    disabled = paths.disable_mark.exists()
    return {
        "autosync": f"disabled ({config.DISABLE_MARK})" if disabled else "ok",
        "sync_in_progress": lock_holder(paths.lock) or False,
        "last_sync": last_sync(paths.sync_log),
    }


def tokensave_files(paths: ProjectPaths) -> set[str]:
    """Пути, уже покрытые структурным индексом tokensave (могут отсутствовать)."""
    if not paths.tokensave_db.exists():
        return set()
    try:
        db = sqlite3.connect(f"file:{paths.tokensave_db}?mode=ro", uri=True, timeout=5)
        try:
            return {row[0] for row in db.execute("SELECT path FROM files")}
        finally:
            db.close()
    except sqlite3.Error:
        return set()


def iter_project_files(root: Path) -> Iterator[Path]:
    """Файлы проекта. В git-репозитории .gitignore соблюдается автоматически."""
    listed = _git_files(root)
    if listed is not None:
        for relative in listed:
            candidate = root / relative
            if candidate.is_file():
                yield candidate
        return

    for current, dirs, files in os.walk(root):
        dirs[:] = [d for d in dirs if d not in config.SKIP_DIRS and not d.startswith(".")]
        for name in files:
            yield Path(current) / name


def list_indexable_files(root: Path) -> tuple[list[tuple[Path, str]], int]:
    """Кандидаты для индексации по дешёвым признакам: (путь, relative).

    Возвращает (отфильтрованный список, сырое число кандидатов до фильтра) —
    второе нужно только для информационной строки в логе ("X из Y в git").
    Здесь только SKIP_DIRS и расширение/имя — без обращения к содержимому:
    проверка на бинарность стоит открытия файла и делается уже в сканере,
    только для файлов, которые изменились.
    """
    result: list[tuple[Path, str]] = []
    raw_count = 0
    for file_path in iter_project_files(root):
        raw_count += 1
        try:
            relative = file_path.relative_to(root).as_posix()
        except ValueError:
            continue
        if any(part in config.SKIP_DIRS for part in Path(relative).parts):
            continue
        if not config.is_text_by_name(file_path):
            continue
        result.append((file_path, relative))
    return result, raw_count


def _git_files(root: Path) -> list[str] | None:
    """Отслеживаемые + новые неигнорируемые файлы. None — это не git-репозиторий."""
    try:
        result = subprocess.run(
            ["git", "-C", str(root), "ls-files", "--cached", "--others",
             "--exclude-standard"],
            capture_output=True, text=True, timeout=60, check=False,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    if result.returncode != 0:
        return None
    return [line for line in result.stdout.splitlines() if line]


def _scan_one(path: Path, relative: str, previous: FileRecord | None, force: bool) -> Scanned:
    try:
        stat = path.stat()
    except OSError:
        return Scanned("error", relative)

    if (
        previous is not None and not force
        and previous.size == stat.st_size and previous.mtime == stat.st_mtime
    ):
        return Scanned("unchanged", relative)

    if not config.is_text_by_content(path, stat.st_size):
        return Scanned("binary", relative)

    try:
        data = path.read_bytes()
    except OSError:
        return Scanned("error", relative)

    record = FileRecord(
        path=relative, hash=hashlib.sha256(data).hexdigest(),
        size=stat.st_size, mtime=stat.st_mtime,
    )
    if previous is not None and not force and previous.hash == record.hash:
        return Scanned("touched", relative, record)

    chunks = chunk_text(data.decode("utf-8", errors="replace"))
    if not chunks:
        return Scanned("empty", relative, record)
    return Scanned("changed", relative, record, chunks)


def _scan_worker(
    files: list[tuple[Path, str]],
    known: dict[str, FileRecord],
    force: bool,
    out: queue.Queue,
    stop: threading.Event,
) -> None:
    """Поток сканирования: только диск и CPU, ни модели, ни БД."""
    try:
        for path, relative in files:
            item = _scan_one(path, relative, known.get(relative), force)
            while not stop.is_set():
                try:
                    out.put(item, timeout=0.2)
                    break
                except queue.Full:
                    continue
            if stop.is_set():
                return
        out.put(None)
    except BaseException as exc:  # noqa: BLE001 — исключение передаётся главному потоку
        out.put(exc)


def index_project(
    root: Path,
    embedder: Embedder | None = None,
    force: bool = False,
    progress: Callable[[str], None] | None = None,
    tick: Callable[[float, int, str], None] | None = None,
    lock_wait: float = 0.0,
) -> IndexReport:
    """Синхронизировать индекс проекта с текущим состоянием файлов.

    progress — редкие информационные строки (модель, найдено файлов, итог).
    tick(done, total, detail) — частые обновления хода работы; вызывающая
    сторона решает, как их показывать (например, однострочным прогресс-баром
    с перезаписью через \\r). Разделены нарочно: progress должен оставаться
    на экране, tick — нет.

    lock_wait — сколько секунд ждать, если проект уже индексирует другой
    процесс; по истечении — SyncInProgress.
    """
    paths = ProjectPaths(root=root)
    paths.ensure_dir()
    encoder = embedder or Embedder()
    report = IndexReport()
    log = progress or (lambda message: None)
    bump = tick or (lambda done, total, detail: None)

    with sync_lock(paths.lock, wait=lock_wait), Store(paths.db) as store:
        mismatch = store.model_mismatch(encoder.model_name)
        if mismatch and not force:
            raise RuntimeError(mismatch)
        if force:
            # Кеш хранит векторы — при смене модели они несовместимы с новыми
            # и должны уйти вместе с индексом. Обычный force модель не меняет,
            # тогда кеш остаётся и переиндексация проходит без обращения к ней.
            _reset(store, drop_cache=mismatch is not None)
        store.stamp(encoder.model_name, config.EMBED_DIM)

        covered = tokensave_files(paths)
        log(f"tokensave покрывает файлов: {len(covered)}")

        all_files, raw_count = list_indexable_files(root)
        total_files = len(all_files)
        skipped_raw = raw_count - total_files
        if skipped_raw:
            log(f"файлов для индексации: {total_files} "
                f"(из {raw_count} в git; {skipped_raw} — не текст или в служебных "
                f"каталогах: node_modules, .cache и т.п.)")
        else:
            log(f"файлов для индексации: {total_files}")

        known = store.known_files()
        seen: set[str] = set()
        pending: list[tuple[str, FileRecord, list[Chunk], bool]] = []
        # Дробный счётчик «готово»: +1 за файл, решённый на месте, и дробный
        # рост по фрагментам для файлов в очереди на эмбеддинг — иначе бар
        # прыгал бы на 100% при постановке в очередь и молчал, пока модель считает.
        done = 0.0

        for item in _scanned(all_files, known, force):
            seen.add(item.relative)
            is_new = item.relative not in known
            in_graph = item.relative in covered

            if item.status == "unchanged":
                report.skipped += 1
                done += 1
                bump(done, total_files, f"без изменений: {item.relative}")
                continue
            if item.status in ("error", "binary"):
                if item.status == "error":
                    report.errors += 1
                elif not is_new:
                    with store.transaction():
                        store.drop_file(item.relative)
                    report.removed += 1
                done += 1
                bump(done, total_files, f"пропуск ({item.status}): {item.relative}")
                continue

            assert item.record is not None
            if item.status == "touched":
                with store.transaction():
                    store.touch_file(item.record)
                report.skipped += 1
                done += 1
                bump(done, total_files, f"то же содержимое: {item.relative}")
                continue
            if item.status == "empty":
                with store.transaction():
                    store.add_file(item.relative, item.record, [], [], in_graph)
                report.skipped += 1
                done += 1
                bump(done, total_files, f"пусто: {item.relative}")
                continue

            assert item.chunks is not None
            if is_new:
                report.added += 1
            else:
                report.updated += 1

            # Такое содержимое уже проходило через модель — в любой ветке и под
            # любым именем. Восстанавливаем готовые векторы: именно это делает
            # возврат на прежнюю ветку почти бесплатным.
            reused = store.cached_chunks(item.record.hash)
            if reused is not None:
                cached_rows, cached_vectors = reused
                with store.transaction():
                    store.add_file(item.relative, item.record, cached_rows,
                                   cached_vectors, in_graph)
                    store.touch_cache(item.record.hash)
                report.restored += 1
                report.chunks += len(cached_rows)
                done += 1
                bump(done, total_files, f"из кеша: {item.relative}")
                continue

            pending.append((item.relative, item.record, item.chunks, in_graph))
            bump(done, total_files,
                 f"в очередь: {item.relative} ({len(item.chunks)} фрагм.)")

        total_chunks = sum(len(chunks) for _, _, chunks, _ in pending)
        log(f"без изменений: {report.skipped}, из кеша: {report.restored}, "
            f"на эмбеддинг: {len(pending)} файлов / {total_chunks} фрагментов")

        if pending:
            started = time.monotonic()
            done = _embed_pending(store, encoder, pending, done, total_files,
                                  total_chunks, bump, report)
            report.embed_seconds = time.monotonic() - started
            rate = total_chunks / report.embed_seconds if report.embed_seconds else 0.0
            log(f"эмбеддинг: {total_chunks} фрагментов за "
                f"{report.embed_seconds:.0f} с ({rate:.1f}/с)")

        with store.transaction():
            for stale in set(known) - seen:
                # Файл, проиндексированный до того, как его имя попало в список
                # секретов: текст остался бы в кеше ещё на 45 дней.
                if config.is_secret_name(Path(stale)):
                    store.forget_cache(known[stale].hash)
                store.drop_file(stale)
                report.removed += 1
            # Кеш растёт от каждой уникальной версии файла во всех ветках — без
            # чистки он копил бы историю бесконечно.
            report.cache_pruned = store.gc_cache()

    return report


def _scanned(
    files: list[tuple[Path, str]], known: dict[str, FileRecord], force: bool
) -> Iterator[Scanned]:
    """Результаты сканирования по мере готовности, из фонового потока."""
    out: queue.Queue = queue.Queue(maxsize=SCAN_QUEUE)
    stop = threading.Event()
    worker = threading.Thread(
        target=_scan_worker, args=(files, known, force, out, stop),
        name="ragsave-scan", daemon=True,
    )
    worker.start()
    try:
        while True:
            item = out.get()
            if item is None:
                return
            if isinstance(item, BaseException):
                raise item
            yield item
    finally:
        stop.set()
        worker.join(timeout=5)


def _embed_pending(
    store: Store,
    encoder: Embedder,
    pending: list[tuple[str, FileRecord, list[Chunk], bool]],
    done: float,
    total_files: int,
    total_chunks: int,
    bump: Callable[[float, int, str], None],
    report: IndexReport,
) -> float:
    """Прогнать очередь через модель одним потоком, записывая файлы по готовности."""
    # Путь файла подмешивается в эмбеддинг: `config/mail.yaml` сообщает тему не
    # хуже содержимого, а для структурированных конфигов — лучше, там прозы нет
    # вовсе и голые ключи (smtp, timeout_seconds) плохо ложатся в вектор.
    # В индексе при этом остаётся чистый текст фрагмента.
    def texts() -> Iterator[str]:
        for relative, _, chunks, _ in pending:
            context = relative.replace("/", " / ").replace("_", " ").replace("-", " ")
            for chunk in chunks:
                yield f"{context}\n\n{chunk.text}"

    vectors = encoder.embed_stream(texts())
    embedded = 0
    for relative, record, chunks, in_graph in pending:
        file_vectors: list[list[float]] = []
        for chunk_index in range(len(chunks)):
            try:
                file_vectors.append(next(vectors))
            except StopIteration:
                raise RuntimeError(
                    f"модель вернула меньше векторов, чем фрагментов ({relative})"
                ) from None
            embedded += 1
            bump(done + (chunk_index + 1) / len(chunks), total_files,
                 f"эмбеддинг: {embedded}/{total_chunks} фрагментов — {relative}")

        rows = [(c.text, c.start_line, c.end_line) for c in chunks]
        with store.transaction():
            store.add_file(relative, record, rows, file_vectors, in_graph)
            # Кладём в кеш по содержимому, а не по пути: тот же файл в другой
            # ветке (или переименованный) переиспользует эти же векторы.
            store.put_cache(record.hash, rows, file_vectors)
        report.chunks += len(rows)
        done += 1
    return done


def _reset(store: Store, drop_cache: bool = False) -> None:
    """Стереть содержимое индекса, сохранив файл БД (для смены модели)."""
    with store.transaction():
        for table in ("vec_chunks", "fts_chunks", "chunks", "files"):
            store.conn.execute(f"DELETE FROM {table}")
        if drop_cache:
            store.conn.execute("DELETE FROM chunk_cache")


def stderr_progress(message: str) -> None:
    print(f"[ragsave] {message}", file=sys.stderr, flush=True)
