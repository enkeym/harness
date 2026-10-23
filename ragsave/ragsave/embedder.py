"""Обёртка над fastembed: текст → вектор.

Модель грузится лениво и только один раз на процесс: MCP-сервер должен
стартовать мгновенно, а инициализация ONNX занимает секунды. Ещё лучше —
не грузить её вовсе: векторы считает общий демон (daemon.py), своя модель —
только у синка без демона и когда демон держит другую модель.
"""

from __future__ import annotations

import ctypes
import gc
import os
import sys
import warnings
from importlib.metadata import version
from itertools import chain, islice
from typing import Iterable, Iterator, Sequence

from . import config, daemon


def _import_onnxruntime_quietly():
    """Импорт onnxruntime без его шума в stderr (daemon.log, sync.log).

    Уже на импорте C++-часть ищет GPU и в WSL печатает warning мимо Python —
    настройка логгера после импорта опаздывает, поэтому fd 2 на время импорта
    уходит в /dev/null. Ошибка импорта всё равно придёт исключением; дальше
    onnxruntime пишет только ошибки (severity 3).
    """
    if "onnxruntime" in sys.modules:
        return sys.modules["onnxruntime"]
    sys.stderr.flush()
    saved, devnull = os.dup(2), os.open(os.devnull, os.O_WRONLY)
    try:
        os.dup2(devnull, 2)
        import onnxruntime
    finally:
        os.dup2(saved, 2)
        os.close(saved)
        os.close(devnull)
    onnxruntime.set_default_logger_severity(3)
    return onnxruntime


def _use_cuda(ort) -> bool:
    """Считать ли на GPU — по config.EMBED_DEVICE и провайдерам onnxruntime.

    CUDA-библиотеки onnxruntime-gpu ставит pip-пакетами nvidia-*, вне путей
    загрузчика: без preload_dlls сессия молча откатывается на CPU.
    """
    if config.EMBED_DEVICE == "cpu":
        return False
    if "CUDAExecutionProvider" not in ort.get_available_providers():
        if config.EMBED_DEVICE == "cuda":
            raise RuntimeError(
                "RAGSAVE_DEVICE=cuda, но onnxruntime без CUDA: нужен onnxruntime-gpu"
            )
        return False
    ort.preload_dlls()
    return True


class Embedder:
    """Ленивый энкодер. Держит одну модель на процесс."""

    def __init__(
        self, model_name: str | None = None, *, use_daemon: bool | None = None
    ) -> None:
        self._model_name = model_name or config.EMBED_MODEL
        self._model: object | None = None
        # None — по config.DAEMON; сам демон держит свой Embedder с False.
        self._use_daemon = use_daemon
        self._daemon_refused = False
        self._engine: str | None = None
        # cuda/cpu — где считает загруженная модель; None — ещё не грузилась.
        self.device: str | None = None
        # Модели семейства e5 обучены с префиксами роли: без них
        # асимметричный поиск (короткий запрос → длинный абзац) деградирует.
        self._needs_prefix = "e5" in self._model_name.lower()

    @property
    def model_name(self) -> str:
        return self._model_name

    @property
    def engine_version(self) -> str:
        """Версия fastembed: при той же модели она меняет векторы (pooling e5 уже менялся).

        Берётся из метаданных пакета — импорт fastembed стоит секунды.
        """
        if self._engine is None:
            self._engine = version("fastembed")
        return self._engine

    def _load(self):
        cuda = _use_cuda(_import_onnxruntime_quietly())
        from fastembed import TextEmbedding

        # fastembed предупреждает о смене pooling e5 на каждой загрузке — её и
        # так ловит engine_version.
        with warnings.catch_warnings():
            warnings.filterwarnings("ignore", message=r".*now uses mean pooling",
                                    category=UserWarning)
            model = TextEmbedding(
                model_name=self._model_name,
                cache_dir=config.MODEL_CACHE,
                threads=config.EMBED_THREADS,
                cuda=cuda,
            )
        self.device = "cuda" if cuda else "cpu"
        return model

    def _ensure(self):
        if self._model is None:
            self._model = self._load()
        return self._model

    def _daemon_on(self) -> bool:
        enabled = config.DAEMON if self._use_daemon is None else self._use_daemon
        return enabled and not self._daemon_refused

    def _via_daemon(
        self, kind: str, texts: list[str], start: bool
    ) -> list[list[float]] | None:
        """Векторы от демона; None — считать своей моделью.

        start — поднять демон, если его нет. Синк не поднимает: в нём демон
        унаследовал бы nice хука. Демона нет и поднимать его не просили —
        штатный случай, в лог не идёт. Таймаут или обрыв — одна повторная
        попытка (демон, ушедший по простою, поиск поднимает заново), дальше
        DaemonFailed: вторая копия модели в MCP-сервере или синке стоила бы 1,5–3,8 ГБ.
        """
        if not self._daemon_on():
            return None
        started = retried = False
        while True:
            try:
                return daemon.request(kind, texts, self._model_name, self.engine_version)
            except daemon.DaemonDown:
                if not start:
                    return None
                if started or not daemon.start():
                    raise daemon.DaemonFailed(
                        f"демон модели не поднялся за {config.DAEMON_START_WAIT:.0f} с; "
                        f"лог — {daemon.log_path()}"
                    ) from None
                started = True
            except daemon.DaemonRefused as exc:
                self._daemon_refused = True
                daemon.log_fallback(str(exc))
                return None
            except daemon.DaemonUnavailable as exc:
                if retried:
                    raise daemon.DaemonFailed(
                        f"демон модели не ответил дважды ({exc}); повторите позже, "
                        f"лог — {daemon.log_path()}"
                    ) from None
                retried = True

    def unload(self) -> None:
        """Отдать память модели (~1,5 ГБ у e5-large); следующий вызов загрузит её снова.

        Вызывать, только когда моделью никто не пользуется. Одного gc мало:
        замер — 1533 → 361 МБ, остальное glibc держит в своих аренах, пока его
        не попросить вернуть через malloc_trim (дальше 94 МБ).
        """
        if self._model is None:
            return
        self._model = None
        gc.collect()
        try:
            ctypes.CDLL("libc.so.6").malloc_trim(0)
        except (OSError, AttributeError):
            pass  # не glibc — остаётся то, что отдал gc

    def warmup(self) -> None:
        """Принудительно скачать и инициализировать модель."""
        self._ensure()

    def _prepare(self, text: str) -> str:
        return f"passage: {text}" if self._needs_prefix else text

    def embed_stream(self, texts: Iterable[str]) -> Iterator[list[float]]:
        """Векторы для потока фрагментов, в порядке подачи.

        Поток идёт пачками в демон, если тот уже запущен: на всех ядрах и без
        второй копии модели, а поиск вклинивается между кусками. Демона нет
        или он упал посреди потока — остаток считает своя модель; демон жив, но
        молчит — DaemonFailed, синк догонит следующий хук.
        """
        if not self._daemon_on():
            yield from self._local_stream(texts)
            return
        rest = iter(texts)
        while batch := list(islice(rest, config.DAEMON_BATCH)):
            vectors = self._via_daemon("passage", batch, start=False)
            if vectors is None:
                yield from self._local_stream(chain(batch, rest))
                return
            yield from vectors

    def _local_stream(self, texts: Iterable[str]) -> Iterator[list[float]]:
        """Векторы своей моделью.

        Один вызов на весь проход индексации: в data-parallel режиме fastembed
        поднимает пул процессов с копией модели на каждый вызов embed, и
        дробить поток на мелкие вызовы означало бы грузить модель заново
        десятки раз. Векторы отдаются по мере готовности батчей, так что
        вызывающая сторона пишет в БД и двигает прогресс, не дожидаясь конца.
        """
        model = self._ensure()
        # fastembed включает пул только для list длиннее batch_size — генератор
        # он считает «маленьким» вводом и всегда обрабатывает в одном процессе.
        prepared: Iterable[str] = (
            [self._prepare(t) for t in texts] if config.EMBED_PARALLEL is not None
            else (self._prepare(t) for t in texts)
        )
        for vector in model.embed(
            prepared, batch_size=config.EMBED_BATCH, parallel=config.EMBED_PARALLEL
        ):
            yield vector.tolist()

    def embed_passages(self, texts: Sequence[str]) -> list[list[float]]:
        """Векторы для индексируемых фрагментов."""
        return list(self.embed_stream(texts))

    def embed_query(self, text: str) -> list[float]:
        """Вектор поискового запроса; демона нет — поднять его, подвёл — DaemonFailed."""
        vectors = self._via_daemon("query", [text], start=True)
        if vectors is not None:
            return vectors[0]
        prepared = f"query: {text}" if self._needs_prefix else text
        model = self._ensure()
        return next(iter(model.embed([prepared]))).tolist()
