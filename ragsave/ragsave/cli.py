"""CLI ragsave: init / sync / reindex / search / status / serve.

Тот же код, что и у MCP-сервера — терминал нужен для первичной индексации,
диагностики и хуков, которым MCP недоступен.
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import sys
import time
from pathlib import Path

from . import __version__, config
from .config import ProjectPaths, find_project_root
from .embedder import Embedder
from .indexer import SyncInProgress, index_project, stderr_progress, sync_state
from .store import Store

_BAR_WIDTH = 28

# Код возврата «проект уже индексируется»: отличим от настоящего отказа (1).
EXIT_BUSY = 3


def _make_bar(min_interval: float = 0.1):
    """Однострочный прогресс-бар с перезаписью через \\r вместо скролла.

    done/total — файлы (доля не меняется во время эмбеддинга уже поставленного
    в очередь батча — двигается только текст детали). min_interval ограничивает
    частоту перерисовки: без этого печать на каждый под-батч из EMBED_SUB_BATCH
    фрагментов на быстрых файлах может мелькать чаще, чем терминал успевает
    отрисовать, и тратить время на саму печать, а не на индексацию.
    """
    last = 0.0
    started = time.monotonic()

    def render(done: float, total: int, detail: str) -> None:
        nonlocal last
        now = time.monotonic()
        finishing = total > 0 and done >= total
        if not finishing and now - last < min_interval:
            return
        last = now

        fraction = 0.0 if total == 0 else min(1.0, done / total)
        filled = int(round(_BAR_WIDTH * fraction))
        bar = "█" * filled + "░" * (_BAR_WIDTH - filled)
        elapsed = now - started
        pct = int(fraction * 100)
        # done дробный внутри батча (эмбеддинг файла ещё не дописан) — в счётчике
        # округляем вниз, чтобы не показывать "16/16" раньше, чем 16-й файл
        # реально попал в индекс.
        shown = min(total, int(done))

        columns = shutil.get_terminal_size(fallback=(100, 20)).columns
        prefix = f"[ragsave] [{bar}] {pct:3d}% ({shown}/{total}) {elapsed:5.0f}с  "
        room = max(10, columns - len(prefix) - 1)
        text = detail if len(detail) <= room else detail[:room - 1] + "…"
        sys.stderr.write(f"\r{prefix}{text}\033[K")
        sys.stderr.flush()

    def finish() -> None:
        sys.stderr.write("\n")
        sys.stderr.flush()

    render.finish = finish  # type: ignore[attr-defined]
    return render


def _root_or_exit(raw: str | None) -> Path:
    root = find_project_root(raw or os.getcwd())
    if root is None:
        print(
            "ragsave: не удалось определить корень проекта "
            "(не git-репозиторий и нет маркеров). Укажите путь явно.",
            file=sys.stderr,
        )
        raise SystemExit(2)
    return root


def _cmd_index(args: argparse.Namespace, force: bool) -> int:
    root = _root_or_exit(args.path)
    quiet = getattr(args, "quiet", False)
    progress = None if quiet else stderr_progress
    bar = None if quiet else _make_bar()
    if not quiet:
        print(f"[ragsave] проект: {root}", file=sys.stderr)
        parallel = f", воркеров: {config.EMBED_PARALLEL}" if config.EMBED_PARALLEL else ""
        print(f"[ragsave] модель: {config.EMBED_MODEL} "
              f"(батч {config.EMBED_BATCH}{parallel})", file=sys.stderr)
    try:
        report = index_project(
            root=root, force=force, progress=progress, tick=bar,
            lock_wait=args.wait,
        )
    except SyncInProgress as exc:
        print(f"ragsave: {exc}", file=sys.stderr)
        return EXIT_BUSY
    except RuntimeError as exc:
        print(f"ragsave: {exc}", file=sys.stderr)
        return 1
    finally:
        if bar is not None:
            bar.finish()
    print(json.dumps(report.as_dict(), ensure_ascii=False, indent=2))
    return 0


def _cmd_search(args: argparse.Namespace) -> int:
    root = _root_or_exit(args.path)
    paths = ProjectPaths(root=root)
    if not paths.db.exists():
        print(f"ragsave: индекс не построен. Выполните: ragsave init", file=sys.stderr)
        return 1

    embedder = Embedder()
    with Store(paths.db) as store:
        mismatch = store.model_mismatch(embedder.model_name)
        if mismatch:
            print(f"ragsave: {mismatch}", file=sys.stderr)
            return 1
        hits = store.search(
            query_vector=embedder.embed_query(args.query),
            query_text=args.query,
            limit=args.limit,
            path_include=args.include,
            path_exclude=args.exclude,
            only_outside_tokensave=args.outside,
        )

    if not hits:
        print("Ничего не найдено.")
        return 0

    if args.json:
        print(json.dumps(
            [{"path": h.path, "start_line": h.start_line, "end_line": h.end_line,
              "score": round(h.score, 5), "in_tokensave": h.in_tokensave,
              "text": h.text} for h in hits],
            ensure_ascii=False, indent=2,
        ))
        return 0

    for index, hit in enumerate(hits, start=1):
        marker = "" if hit.in_tokensave else "  [вне tokensave]"
        print(f"--- {index}. {hit.path}:{hit.start_line}-{hit.end_line} "
              f" score={hit.score:.4f}{marker}")
        print(hit.text)
        print()
    return 0


def _cmd_status(args: argparse.Namespace) -> int:
    root = _root_or_exit(args.path)
    paths = ProjectPaths(root=root)
    if not paths.db.exists():
        print(json.dumps(
            {"project": str(root), "indexed": False}, ensure_ascii=False, indent=2))
        return 0
    with Store(paths.db) as store:
        stats = store.stats()
    stats.update({"project": str(root), "indexed": True,
                  "current_model": config.EMBED_MODEL})
    stats.update(sync_state(paths))
    print(json.dumps(stats, ensure_ascii=False, indent=2))
    return 0


def _cmd_serve(_: argparse.Namespace) -> int:
    from .server import main as serve_main

    serve_main()
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="ragsave",
        description="Смысловой поиск по проекту — RAG-слой, парный к tokensave.",
    )
    parser.add_argument("--version", action="version", version=f"ragsave {__version__}")
    sub = parser.add_subparsers(dest="command", required=True)

    for name, help_text in (
        ("init", "построить индекс (инкрементально, безопасно повторять)"),
        ("sync", "обновить индекс изменившимися файлами"),
        ("reindex", "перестроить индекс с нуля (после смены модели)"),
    ):
        node = sub.add_parser(name, help=help_text)
        node.add_argument("path", nargs="?", help="путь к проекту")
        node.add_argument("--quiet", action="store_true", help="без прогресса")
        node.add_argument(
            "--wait", type=float, default=0.0, metavar="СЕК",
            help="ждать до СЕК секунд, если проект уже индексирует другой процесс "
                 "(по умолчанию не ждать и выйти с кодом 3)",
        )

    search = sub.add_parser("search", help="найти фрагменты по смыслу")
    search.add_argument("query", help="поисковый запрос")
    search.add_argument("path", nargs="?", help="путь к проекту")
    search.add_argument("-n", "--limit", type=int, default=8)
    search.add_argument("--include", action="append", help="фильтр пути (подстрока)")
    search.add_argument("--exclude", action="append", help="исключить путь")
    search.add_argument("--outside", action="store_true",
                        help="только файлы вне индекса tokensave")
    search.add_argument("--json", action="store_true")

    status = sub.add_parser("status", help="статистика индекса")
    status.add_argument("path", nargs="?", help="путь к проекту")

    sub.add_parser("serve", help="запустить MCP-сервер (stdio)")
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    match args.command:
        case "init" | "sync":
            return _cmd_index(args, force=False)
        case "reindex":
            return _cmd_index(args, force=True)
        case "search":
            return _cmd_search(args)
        case "status":
            return _cmd_status(args)
        case "serve":
            return _cmd_serve(args)
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
