"""Общие ограничения и проверка актуальности результатов CLI и MCP."""

from __future__ import annotations

import hashlib
from pathlib import Path

from . import config
from .store import SearchHit, Store


def search_limit(value: object) -> int:
    limit = int(value if value is not None else 8)
    if not 1 <= limit <= config.SEARCH_MAX_HITS:
        raise ValueError(f"limit должен быть от 1 до {config.SEARCH_MAX_HITS}")
    return limit


def current_hits(root: Path, store: Store, hits: list[SearchHit]) -> tuple[list[SearchHit], list[str]]:
    """Не отдавать устаревший текст, секреты и ссылки за пределы проекта."""
    records = store.known_files()
    checked: dict[str, bool] = {}
    fresh: list[SearchHit] = []
    stale: list[str] = []
    seen: set[tuple[str, int, int, str]] = set()
    remaining = config.SEARCH_MAX_CHARS
    for hit in hits:
        if hit.path not in checked:
            record = records.get(hit.path)
            valid = record is not None and config.is_project_file(root, hit.path)
            if valid:
                try:
                    with config.open_project_file(root, hit.path) as handle:
                        data = handle.read(config.MAX_FILE_BYTES + 1)
                    valid = (len(data) <= config.MAX_FILE_BYTES
                             and hashlib.sha256(data).hexdigest() == record.hash)
                except (OSError, ValueError):
                    valid = False
            checked[hit.path] = valid
            if not valid:
                stale.append(hit.path)
        identity = (hit.path, hit.start_line, hit.end_line, hit.text)
        if not checked[hit.path] or identity in seen:
            continue
        seen.add(identity)
        if len(hit.text) > remaining:
            continue
        remaining -= len(hit.text)
        fresh.append(hit)
    return fresh, stale


def stale_note(stale: list[str]) -> str | None:
    if not stale:
        return None
    names = ", ".join(stale[:5])
    return (f"ragsave: устаревшие или недоступные файлы исключены: {names}. "
            "Сверь текущий файл через tokensave_read; обнови существующий индекс через rag_index.")
