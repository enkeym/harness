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
    """Разбить текст с жёстким лимитом и исходными номерами строк."""
    if max_chars < 1:
        raise ValueError("max_chars должен быть положительным")
    chunks: list[Chunk] = []
    buffer: list[str] = []
    start = 1

    def flush(lines: list[str], first: int) -> None:
        if chunk := _flush(lines, first):
            chunks.append(chunk)

    for index, line in enumerate(content.splitlines(), start=1):
        if len(line) > max_chars:
            flush(buffer, start)
            buffer = []
            for offset in range(0, len(line), max_chars):
                flush([line[offset:offset + max_chars]], index)
            start = index + 1
            continue
        if _HEADING.match(line) and buffer:
            flush(buffer, start)
            buffer = []
            start = index
        if buffer and len("\n".join([*buffer, line])) > max_chars:
            cut = _last_blank(buffer)
            if cut is not None:
                flush(buffer[:cut], start)
                buffer = buffer[cut:]
                start += cut
            if buffer and len("\n".join([*buffer, line])) > max_chars:
                flush(buffer, start)
                overlap = min(config.CHUNK_OVERLAP_LINES, len(buffer) - 1)
                buffer = buffer[-overlap:] if overlap else []
                while buffer and len("\n".join([*buffer, line])) > max_chars:
                    buffer.pop(0)
                start = index - len(buffer)
        if not buffer:
            start = index
        buffer.append(line)
    flush(buffer, start)
    return chunks


def _last_blank(buffer: list[str]) -> int | None:
    """Индекс после последней пустой строки — точка разреза. None, если её нет.

    Не режем у самого начала: фрагмент из пары строк бесполезен для поиска.
    """
    for position in range(len(buffer) - 1, 2, -1):
        if not buffer[position].strip():
            return position + 1
    return None
