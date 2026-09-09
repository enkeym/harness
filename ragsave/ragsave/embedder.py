"""Обёртка над fastembed: текст → вектор.

Модель грузится лениво и только один раз на процесс: MCP-сервер должен
стартовать мгновенно, а инициализация ONNX занимает секунды.
"""

from __future__ import annotations

from typing import Iterable, Iterator, Sequence

from . import config


class Embedder:
    """Ленивый энкодер. Держит одну модель на процесс."""

    def __init__(self, model_name: str | None = None) -> None:
        self._model_name = model_name or config.EMBED_MODEL
        self._model: object | None = None
        # Модели семейства e5 обучены с префиксами роли: без них
        # асимметричный поиск (короткий запрос → длинный абзац) деградирует.
        self._needs_prefix = "e5" in self._model_name.lower()

    @property
    def model_name(self) -> str:
        return self._model_name

    def _ensure(self):
        if self._model is None:
            from fastembed import TextEmbedding

            self._model = TextEmbedding(
                model_name=self._model_name,
                cache_dir=config.MODEL_CACHE,
                threads=config.EMBED_THREADS,
            )
        return self._model

    def warmup(self) -> None:
        """Принудительно скачать и инициализировать модель."""
        self._ensure()

    def _prepare(self, text: str) -> str:
        return f"passage: {text}" if self._needs_prefix else text

    def embed_stream(self, texts: Iterable[str]) -> Iterator[list[float]]:
        """Векторы для потока фрагментов, в порядке подачи.

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
        """Вектор поискового запроса."""
        prepared = f"query: {text}" if self._needs_prefix else text
        model = self._ensure()
        return next(iter(model.embed([prepared]))).tolist()
