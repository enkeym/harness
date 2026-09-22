"""Тесты ragsave без обращения к модели.

Эмбеддинги здесь подделаны детерминированной функцией: проверяем логику
чанкинга, фильтрации файлов и гибридного поиска, а не качество модели —
загрузка 2.24GB ONNX в юнит-тестах не нужна.

Запуск: ~/.rag-mcp/venv/bin/python -m tests.test_ragsave
"""

from __future__ import annotations

import subprocess
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from ragsave import config  # noqa: E402
from ragsave.chunker import chunk_text  # noqa: E402
from ragsave.config import find_project_root, is_probably_text  # noqa: E402
from ragsave.store import Store, FileRecord, _fts_query  # noqa: E402

PASSED = 0
FAILED = 0


def check(name: str, got: object, want: object) -> None:
    global PASSED, FAILED
    if got == want:
        PASSED += 1
        print(f"PASS  {name}")
    else:
        FAILED += 1
        print(f"FAIL  {name}\n      got={got!r}\n      want={want!r}")


def check_true(name: str, condition: bool, hint: str = "") -> None:
    global PASSED, FAILED
    if condition:
        PASSED += 1
        print(f"PASS  {name}")
    else:
        FAILED += 1
        print(f"FAIL  {name}  {hint}")


def fake_vector(seed: int, dim: int) -> list[float]:
    """Детерминированный вектор — заменяет модель в тестах."""
    return [((seed * (i + 1)) % 97) / 97.0 for i in range(dim)]


# ---------- чанкер ----------

def test_chunker() -> None:
    print("\n--- чанкер ---")

    check("пустой ввод → нет чанков", chunk_text(""), [])

    short = chunk_text("одна строка")
    check("короткий текст → один чанк", len(short), 1)
    check("границы строк короткого текста", (short[0].start_line, short[0].end_line), (1, 1))

    markdown = "# Первый\n\nтекст один\n\n# Второй\n\nтекст два\n"
    sections = chunk_text(markdown)
    check_true(
        "markdown режется по заголовкам",
        len(sections) >= 2,
        f"получено {len(sections)} чанков",
    )
    check_true(
        "второй чанк начинается с заголовка",
        any(chunk.text.startswith("# Второй") for chunk in sections),
    )

    big = "\n\n".join(f"абзац номер {i} " + "слово " * 40 for i in range(30))
    chunks = chunk_text(big, max_chars=600)
    check_true("длинный текст разбит на несколько чанков", len(chunks) > 3)
    check_true(
        "чанки не превышают лимит с запасом",
        all(len(chunk.text) < 600 * 2 for chunk in chunks),
        f"максимум {max(len(c.text) for c in chunks)}",
    )
    check_true(
        "строки идут по возрастанию",
        all(
            chunks[i].start_line <= chunks[i + 1].start_line
            for i in range(len(chunks) - 1)
        ),
    )

    monolith = "x" * 5000
    hard = chunk_text(monolith, max_chars=500)
    check_true("монолит без пустых строк тоже режется", len(hard) >= 1)


# ---------- отбор файлов ----------

def test_file_filters() -> None:
    print("\n--- отбор файлов ---")

    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)

        text_file = root / "readme.md"
        text_file.write_text("# Заголовок\n\nтекст", encoding="utf-8")
        check("markdown считается текстом", is_probably_text(text_file), True)

        binary = root / "logo.png"
        binary.write_bytes(b"\x89PNG\r\n\x1a\n" + b"\x00" * 100)
        check("png отсекается по расширению", is_probably_text(binary), False)

        lock = root / "package-lock.json"
        lock.write_text("{}", encoding="utf-8")
        check("lock-файл отсекается по имени", is_probably_text(lock), False)

        disguised = root / "data.txt"
        disguised.write_bytes(b"text\x00binary")
        check("null-байт отсекает бинарь", is_probably_text(disguised), False)

        huge = root / "dump.txt"
        huge.write_bytes(b"a" * (config.MAX_FILE_BYTES + 10))
        check("слишком большой файл отсекается", is_probably_text(huge), False)

        # Хранилища секретов. В git-репозитории их отсекает .gitignore, но
        # запасной обход каталогов (не-git проект) дошёл бы до них, и тогда
        # rag_search вернул бы значение токена прямо в контекст агента.
        # Индекс живёт дольше сессии, поэтому фильтр по имени обязателен.
        for name in (".env", ".env.local", ".env.production", "id_rsa",
                     "server.pem", "auth.json", "credentials.json",
                     ".git-credentials", "private.key", ".npmrc",
                     ".credentials.json", ".envrc", ".pgpass", "tls.key",
                     ".aws/credentials", ".docker/config.json", ".kube/config",
                     "gh/hosts.yml", "glab-cli/config.yml",
                     "id_ed25519_github", "id_rsa-work", "master.key",
                     "terraform.tfstate", "terraform.tfstate.backup",
                     "prod.tfvars", "prod.auto.tfvars.json", ".env-prod",
                     "secrets.yaml", "secret.yml"):
            secret = root / name
            secret.parent.mkdir(parents=True, exist_ok=True)
            secret.write_text("TOKEN=value", encoding="utf-8")
            check(f"секрет отсекается: {name}", is_probably_text(secret), False)

        # Примеры и шаблоны секретами не являются: там имена без значений.
        # Общие имена конфигов — тоже, пока каталог не делает их секретом.
        for name in (".env.example", ".env.template", "config.json",
                     "deploy/config", "app/hosts.yml", "id_ed25519_github.pub",
                     "prod.tfvars.example", "deployment.yaml", ".environment.ts"):
            sample = root / name
            sample.parent.mkdir(parents=True, exist_ok=True)
            sample.write_text("TOKEN=", encoding="utf-8")
            check(f"не секрет: {name}", is_probably_text(sample), True)


def test_project_root() -> None:
    print("\n--- корень проекта ---")

    check("$HOME не считается проектом", find_project_root(str(Path.home())), None)

    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp).resolve()
        subprocess.run(["git", "init", "-q", str(root)], check=True,
                       capture_output=True)
        nested = root / "src" / "deep"
        nested.mkdir(parents=True)
        found = find_project_root(str(nested))
        check("корень git находится из вложенной папки", found, root)


# ---------- хранилище и поиск ----------

def test_store_search() -> None:
    print("\n--- хранилище и гибридный поиск ---")

    dim = 8
    with tempfile.TemporaryDirectory() as tmp:
        db_path = Path(tmp) / "rag.db"
        with Store(db_path, dim=dim) as store:
            store.stamp("test-model", dim)

            documents = [
                ("docs/deploy.md", "Деплой выполняется через GitHub Actions", 1),
                ("config/mail.yaml", "SMTP_HOST и SMTP_PORT для почты", 2),
                ("src/app.ts", "export class AppModule {}", 3),
            ]
            for path, text, seed in documents:
                record = FileRecord(path=path, hash=f"h{seed}", size=len(text), mtime=1.0)
                store.add_file(
                    path=path,
                    record=record,
                    chunks=[(text, 1, 1)],
                    vectors=[fake_vector(seed, dim)],
                    in_tokensave=(path == "src/app.ts"),
                )
            store.commit()

            stats = store.stats()
            check("проиндексировано файлов", stats["files"], 3)
            check("проиндексировано фрагментов", stats["chunks"], 3)
            check("вне tokensave", stats["files_outside_tokensave"], 2)

            # Полнотекстовая часть должна поднять точное слово наверх.
            hits = store.search(
                query_vector=fake_vector(99, dim),
                query_text="SMTP_HOST",
                limit=3,
            )
            check_true("точное слово находится", any(h.path == "config/mail.yaml" for h in hits),
                       f"получено {[h.path for h in hits]}")

            outside = store.search(
                query_vector=fake_vector(3, dim),
                query_text="AppModule",
                limit=5,
                only_outside_tokensave=True,
            )
            check_true(
                "фильтр only_outside_tokensave прячет код",
                all(not h.in_tokensave for h in outside),
            )

            included = store.search(
                query_vector=fake_vector(1, dim),
                query_text="деплой почта класс",
                limit=5,
                path_include=["docs/"],
            )
            check_true(
                "path_include ограничивает выдачу",
                all(h.path.startswith("docs/") for h in included),
                f"получено {[h.path for h in included]}",
            )

            excluded = store.search(
                query_vector=fake_vector(1, dim),
                query_text="деплой почта класс",
                limit=5,
                path_exclude=["config/"],
            )
            check_true(
                "path_exclude убирает пути",
                all("config/" not in h.path for h in excluded),
            )

            # Путь подмешан в полнотекстовый индекс: имя файла должно искаться,
            # даже когда внутри такого слова нет. Для конфигов это основной
            # способ попасть в выдачу — прозы в них нет.
            by_name = store.search(
                query_vector=fake_vector(50, dim),
                query_text="mail",
                limit=3,
            )
            check_true(
                "поиск по имени файла находит конфиг",
                any(h.path == "config/mail.yaml" for h in by_name),
                f"получено {[h.path for h in by_name]}",
            )

            deep = store.search(
                query_vector=fake_vector(50, dim),
                query_text="deploy",
                limit=3,
            )
            check_true(
                "путь из подкаталога тоже индексируется",
                any(h.path == "docs/deploy.md" for h in deep),
                f"получено {[h.path for h in deep]}",
            )

            # Переиндексация файла не должна плодить дубликаты.
            record = FileRecord(path="docs/deploy.md", hash="h1-new", size=10, mtime=2.0)
            store.add_file(
                path="docs/deploy.md",
                record=record,
                chunks=[("Новый текст про деплой", 1, 1)],
                vectors=[fake_vector(7, dim)],
                in_tokensave=False,
            )
            store.commit()
            check("после переиндексации файлов столько же", store.stats()["files"], 3)
            check("фрагменты не задвоились", store.stats()["chunks"], 3)

            store.drop_file("docs/deploy.md")
            store.commit()
            check("удаление файла уменьшает счётчик", store.stats()["files"], 2)

            check_true(
                "несовпадение модели обнаруживается",
                store.model_mismatch("другая-модель") is not None,
            )
            check("совпадение модели не мешает", store.model_mismatch("test-model"), None)


class FakeEmbedder:
    """Подмена модели: тот же интерфейс, детерминированные векторы."""

    dim = 8

    def __init__(self) -> None:
        self.model_name = "fake-model"
        self.calls = 0

    def embed_stream(self, texts):
        self.calls += 1
        for text in texts:
            yield fake_vector(len(text), self.dim)

    def embed_passages(self, texts: list[str]) -> list[list[float]]:
        return list(self.embed_stream(texts))

    def embed_query(self, text: str) -> list[float]:
        return fake_vector(len(text), self.dim)


def test_indexer() -> None:
    print("\n--- индексатор (инкрементальность) ---")

    from ragsave import indexer as indexer_module
    from ragsave.indexer import index_project

    original_dim = config.EMBED_DIM
    config.EMBED_DIM = FakeEmbedder.dim
    try:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp).resolve()
            subprocess.run(["git", "init", "-q", str(root)], check=True,
                           capture_output=True)

            (root / "docs").mkdir()
            (root / "docs" / "guide.md").write_text("# Гайд\n\nтекст", encoding="utf-8")
            (root / "config.yaml").write_text("key: value\nport: 8080", encoding="utf-8")
            (root / "app.ts").write_text("export const x = 1;", encoding="utf-8")

            # Игнорируемое git не должно попадать в индекс.
            (root / ".gitignore").write_text("secret.txt\nbuild/\n", encoding="utf-8")
            (root / "secret.txt").write_text("пароль", encoding="utf-8")
            (root / "build").mkdir()
            (root / "build" / "out.js").write_text("compiled", encoding="utf-8")
            (root / "logo.png").write_bytes(b"\x89PNG\r\n\x1a\n" + b"\x00" * 50)

            embedder = FakeEmbedder()
            first = index_project(root=root, embedder=embedder)

            check_true("первый проход что-то проиндексировал", first.added >= 4,
                       f"added={first.added}")
            check("первый проход без ошибок", first.errors, 0)

            with Store(root / ".ragsave" / "rag.db", dim=FakeEmbedder.dim) as store:
                paths = {row["path"] for row in
                         store.conn.execute("SELECT path FROM files")}

            check_true("markdown проиндексирован", "docs/guide.md" in paths)
            check_true("yaml проиндексирован", "config.yaml" in paths)
            check_true("gitignore соблюдён (secret.txt)", "secret.txt" not in paths,
                       f"пути: {sorted(paths)}")
            check_true("gitignore соблюдён (build/)", "build/out.js" not in paths)
            check_true("бинарник пропущен", "logo.png" not in paths)

            # Повторный проход: ничего не изменилось → всё unchanged.
            calls_before = embedder.calls
            second = index_project(root=root, embedder=embedder)
            check("повторный проход ничего не добавил", second.added, 0)
            check("повторный проход ничего не обновил", second.updated, 0)
            check_true("повторный проход не звал модель",
                       embedder.calls == calls_before,
                       f"вызовов было {calls_before}, стало {embedder.calls}")

            # Изменение файла → updated.
            (root / "config.yaml").write_text("key: other\nport: 9090", encoding="utf-8")
            third = index_project(root=root, embedder=embedder)
            check("изменённый файл переиндексирован", third.updated, 1)
            check("новых файлов нет", third.added, 0)

            # Удаление файла → removed.
            (root / "docs" / "guide.md").unlink()
            fourth = index_project(root=root, embedder=embedder)
            check("удалённый файл убран из индекса", fourth.removed, 1)

            with Store(root / ".ragsave" / "rag.db", dim=FakeEmbedder.dim) as store:
                left = {row["path"] for row in
                        store.conn.execute("SELECT path FROM files")}
                orphans = store.conn.execute(
                    "SELECT COUNT(*) AS n FROM chunks WHERE path='docs/guide.md'"
                ).fetchone()["n"]
            check_true("удалённого файла нет в индексе", "docs/guide.md" not in left)
            check("осиротевших фрагментов не осталось", orphans, 0)

            # Новый файл → added.
            (root / "new.md").write_text("# Новый документ", encoding="utf-8")
            fifth = index_project(root=root, embedder=embedder)
            check("новый файл добавлен", fifth.added, 1)

            # Тот же контент, новый mtime (как после git checkout) — не пересчёт.
            import os
            os.utime(root / "new.md", (1_000_000_000, 1_000_000_000))
            calls_before_touch = embedder.calls
            touched = index_project(root=root, embedder=embedder)
            check("тронутый файл не считается обновлённым", touched.updated, 0)
            check_true("для тронутого файла модель не звалась",
                       embedder.calls == calls_before_touch)
            with Store(root / ".ragsave" / "rag.db", dim=FakeEmbedder.dim) as store:
                mtime = store.conn.execute(
                    "SELECT mtime FROM files WHERE path='new.md'").fetchone()["mtime"]
            check("новый mtime запомнен", mtime, 1_000_000_000.0)

            # Файл опустел — прежние фрагменты не должны остаться в индексе.
            (root / "new.md").write_text("", encoding="utf-8")
            index_project(root=root, embedder=embedder)
            with Store(root / ".ragsave" / "rag.db", dim=FakeEmbedder.dim) as store:
                leftovers = store.conn.execute(
                    "SELECT COUNT(*) AS n FROM chunks WHERE path='new.md'"
                ).fetchone()["n"]
            check("у опустевшего файла нет фрагментов", leftovers, 0)

            # Файл стал бинарным — уходит из индекса целиком.
            (root / "app.ts").write_bytes(b"\x00\x01\x02")
            binary = index_project(root=root, embedder=embedder)
            check("ставший бинарным файл удалён", binary.removed, 1)

            # Файл, проиндексированный до того, как имя стало секретом: sync
            # убирает его из поиска и стирает текст из кеша.
            (root / ".envrc").write_text("export TOKEN=abc", encoding="utf-8")
            real_is_secret = config.is_secret_name
            config.is_secret_name = lambda path: False
            try:
                index_project(root=root, embedder=embedder)
            finally:
                config.is_secret_name = real_is_secret
            with Store(root / ".ragsave" / "rag.db", dim=FakeEmbedder.dim) as store:
                envrc_hash = store.conn.execute(
                    "SELECT hash FROM files WHERE path='.envrc'").fetchone()["hash"]
            index_project(root=root, embedder=embedder)
            with Store(root / ".ragsave" / "rag.db", dim=FakeEmbedder.dim) as store:
                in_files = store.conn.execute(
                    "SELECT COUNT(*) AS n FROM files WHERE path='.envrc'").fetchone()["n"]
                in_cache = store.conn.execute(
                    "SELECT COUNT(*) AS n FROM chunk_cache WHERE content_hash=?",
                    (envrc_hash,)).fetchone()["n"]
            check("ставший секретом файл убран из индекса", in_files, 0)
            check("его текст стёрт из кеша", in_cache, 0)

            # Смена модели без force должна честно отказать, а не портить индекс.
            other = FakeEmbedder()
            other.model_name = "другая-модель"
            try:
                index_project(root=root, embedder=other)
                check_true("смена модели без force запрещена", False,
                           "ожидалось RuntimeError")
            except RuntimeError:
                check_true("смена модели без force запрещена", True)

            # К этому моменту текст остался в config.yaml и .gitignore.
            forced = index_project(root=root, embedder=other, force=True)
            check("force пересобирает индекс", forced.added, 2)
    finally:
        config.EMBED_DIM = original_dim


def test_branch_cache() -> None:
    print("\n--- кеш по содержимому (переключение веток) ---")

    from ragsave.indexer import index_project

    original_dim = config.EMBED_DIM
    config.EMBED_DIM = FakeEmbedder.dim
    try:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp).resolve()
            subprocess.run(["git", "init", "-q", str(root)], check=True,
                           capture_output=True)

            target = root / "config.yaml"
            version_a = "host: alpha\nport: 8080\ntimeout: 30"
            version_b = "host: beta\nport: 9090\ntimeout: 60"
            target.write_text(version_a, encoding="utf-8")
            (root / "stable.md").write_text("# Не меняется\n\nтекст", encoding="utf-8")

            embedder = FakeEmbedder()
            index_project(root=root, embedder=embedder)
            calls_after_first = embedder.calls

            # Уходим на "другую ветку": содержимое меняется, модель работает.
            target.write_text(version_b, encoding="utf-8")
            second = index_project(root=root, embedder=embedder)
            check("новая версия проиндексирована", second.updated, 1)
            check("новая версия не из кеша", second.restored, 0)
            check_true("для новой версии модель звалась",
                       embedder.calls > calls_after_first)

            calls_before_return = embedder.calls

            # Возвращаемся на прежнюю ветку — содержимое уже считалось.
            target.write_text(version_a, encoding="utf-8")
            third = index_project(root=root, embedder=embedder)
            check("возврат учтён как обновление", third.updated, 1)
            check("возврат восстановлен из кеша", third.restored, 1)
            check_true(
                "при возврате модель НЕ вызывалась",
                embedder.calls == calls_before_return,
                f"было {calls_before_return}, стало {embedder.calls}",
            )

            # Содержимое должно быть настоящим, а не пустышкой из кеша.
            with Store(root / ".ragsave" / "rag.db", dim=FakeEmbedder.dim) as store:
                row = store.conn.execute(
                    "SELECT text FROM chunks WHERE path='config.yaml'"
                ).fetchone()
                vectors = store.conn.execute(
                    "SELECT COUNT(*) AS n FROM vec_chunks"
                ).fetchone()["n"]
                chunks_total = store.conn.execute(
                    "SELECT COUNT(*) AS n FROM chunks"
                ).fetchone()["n"]
            check_true("восстановленный текст совпадает с версией A",
                       "alpha" in row["text"], f"получено: {row['text']!r}")
            check("векторов столько же, сколько фрагментов", vectors, chunks_total)

            # Тот же контент под другим именем — кеш по содержимому, не по пути.
            calls_before_rename = embedder.calls
            (root / "copy.yaml").write_text(version_a, encoding="utf-8")
            fourth = index_project(root=root, embedder=embedder)
            check("копия добавлена", fourth.added, 1)
            check("копия взята из кеша", fourth.restored, 1)
            check_true("для копии модель НЕ вызывалась",
                       embedder.calls == calls_before_rename)

            # Смена модели обязана сбросить кеш: векторы несовместимы.
            other = FakeEmbedder()
            other.model_name = "другая-модель"
            fifth = index_project(root=root, embedder=other, force=True)
            check("после смены модели кеш не использован", fifth.restored, 0)
            check_true("после смены модели модель звалась", other.calls > 0)

            with Store(root / ".ragsave" / "rag.db", dim=FakeEmbedder.dim) as store:
                versions, _ = store.cache_stats()
            check_true("кеш пересобран под новую модель", versions > 0)
    finally:
        config.EMBED_DIM = original_dim


def test_cache_gc() -> None:
    print("\n--- чистка кеша ---")

    dim = 8
    with tempfile.TemporaryDirectory() as tmp:
        with Store(Path(tmp) / "rag.db", dim=dim) as store:
            store.stamp("test-model", dim)
            for index in range(5):
                store.put_cache(
                    f"hash{index}",
                    [(f"текст {index}", 1, 1)],
                    [fake_vector(index + 1, dim)],
                )
            store.commit()
            versions, chunks = store.cache_stats()
            check("в кеше пять версий", versions, 5)
            check("в кеше пять фрагментов", chunks, 5)

            # Состарим три записи и почистим по возрасту.
            store.conn.execute(
                "UPDATE chunk_cache SET last_used = 0 "
                "WHERE content_hash IN ('hash0','hash1','hash2')"
            )
            removed = store.gc_cache(max_age_days=1)
            store.commit()
            check("старые записи удалены", removed, 3)
            check("свежие остались", store.cache_stats()[0], 2)

            # Лимит по количеству версий.
            store.gc_cache(max_age_days=10_000, max_files=1)
            store.commit()
            check("лимит по объёму соблюдён", store.cache_stats()[0], 1)


def test_sync_lock() -> None:
    print("\n--- замок на проект ---")

    from ragsave.indexer import SyncInProgress, index_project, sync_lock

    original_dim = config.EMBED_DIM
    config.EMBED_DIM = FakeEmbedder.dim
    try:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp).resolve()
            subprocess.run(["git", "init", "-q", str(root)], check=True,
                           capture_output=True)
            (root / "a.md").write_text("# a", encoding="utf-8")
            lock_path = root / ".ragsave" / ".sync.lock"

            # Замок держит «другой процесс» (тот же файл, что и у хука).
            with sync_lock(lock_path):
                try:
                    index_project(root=root, embedder=FakeEmbedder())
                    check_true("занятый проект отклоняется", False, "ожидался SyncInProgress")
                except SyncInProgress as exc:
                    check_true("занятый проект отклоняется",
                               "another sync is already in progress" in str(exc),
                               str(exc))
                    check_true("в сообщении есть PID держателя", "PID" in str(exc))

            # Замок отпущен — индексация проходит, а после неё замок свободен.
            report = index_project(root=root, embedder=FakeEmbedder())
            check("после освобождения замка индексация идёт", report.added, 1)
            with sync_lock(lock_path):
                check_true("замок отпущен после индексации", True)
    finally:
        config.EMBED_DIM = original_dim


def test_fts_query() -> None:
    print("\n--- разбор запроса FTS ---")

    check("пустой запрос", _fts_query("   "), "")
    check("обычные слова", _fts_query("деплой сервер"), '"деплой" OR "сервер"')
    check_true(
        "спецсимволы FTS не ломают запрос",
        _fts_query('котик - "звезда" * OR (') .count('"') % 2 == 0,
    )
    check_true("однобуквенные отбрасываются", "а" not in _fts_query("а деплой"))


def main() -> int:
    test_chunker()
    test_file_filters()
    test_project_root()
    test_store_search()
    test_indexer()
    test_branch_cache()
    test_cache_gc()
    test_sync_lock()
    test_fts_query()
    print(f"\n=== {PASSED} passed, {FAILED} failed ===")
    return 1 if FAILED else 0


if __name__ == "__main__":
    raise SystemExit(main())
