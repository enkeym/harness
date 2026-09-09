"""Разбиение файла на фрагменты для эмбеддинга.

Режем по смысловым границам (пустая строка, заголовок markdown), а не слепым
окном: так фрагмент почти всегда остаётся цельной функцией, секцией конфига
или разделом документа. Каждый фрагмент помнит диапазон строк — по нему потом
показываем ссылку file:line.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

from . import config

_HEADING = re.compile(r"^(#{1,6})\s+\S")


@dataclass(frozen=True)
class Chunk:
    """Фрагмент файла с привязкой к строкам (1-indexed, обе границы включены)."""

    text: str
    start_line: int
    end_line: int


def _flush(buffer: list[str], start: int) -> Chunk | None:
    text = "\n".join(buffer).strip()
    if not text:
        return None
    return Chunk(text=text, start_line=start, end_line=start + len(buffer) - 1)


def chunk_text(content: str, max_chars: int = config.CHUNK_CHARS) -> list[Chunk]:
    """Разбить содержимое файла на фрагменты не длиннее max_chars.

    Границы: заголовок markdown начинает новый фрагмент; пустая строка —
    допустимая точка разреза при переполнении; сверхдлинный монолитный блок
    режется жёстко по строкам, чтобы не превысить лимит модели.
    """
    lines = content.splitlines()
    if not lines:
        return []

    chunks: list[Chunk] = []
    buffer: list[str] = []
    start = 1
    size = 0

    for index, line in enumerate(lines, start=1):
        is_heading = bool(_HEADING.match(line))

        # Заголовок markdown — начало новой секции: закрываем накопленное.
        if is_heading and buffer and size > 0:
            chunk = _flush(buffer, start)
            if chunk:
                chunks.append(chunk)
            buffer, size, start = [], 0, index

        buffer.append(line)
        size += len(line) + 1

        if size < max_chars:
            continue

        # Переполнение: ищем последнюю пустую строку как точку разреза,
        # чтобы не рвать абзац или тело функции посередине.
        cut = _last_blank(buffer)
        if cut is None:
            chunk = _flush(buffer, start)
            if chunk:
                chunks.append(chunk)
            tail = buffer[-config.CHUNK_OVERLAP_LINES:]
            start = index + 1 - len(tail)
            buffer = list(tail)
        else:
            head, tail = buffer[:cut], buffer[cut:]
            chunk = _flush(head, start)
            if chunk:
                chunks.append(chunk)
            start = start + cut
            buffer = tail
        size = sum(len(item) + 1 for item in buffer)

    chunk = _flush(buffer, start)
    if chunk:
        chunks.append(chunk)
    return chunks


def _last_blank(buffer: list[str]) -> int | None:
    """Индекс после последней пустой строки — точка разреза. None, если её нет.

    Не режем у самого начала: фрагмент из пары строк бесполезен для поиска.
    """
    for position in range(len(buffer) - 1, 2, -1):
        if not buffer[position].strip():
            return position + 1
    return None
