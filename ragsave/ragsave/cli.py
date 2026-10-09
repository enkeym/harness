"""CLI ragsave: init / sync / reindex / search / status / serve.

Тот же код, что и у MCP-сервера — терминал нужен для первичной индексации,
диагностики и хуков, которым MCP недоступен.
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import signal
import subprocess
import sys
import time
from pathlib import Path

from . import __version__, config
from .config import ProjectPaths, find_project_root
from .embedder import Embedder
from .indexer import (
    SyncInProgress, holder_pid, index_project, lock_holder, read_progress,
    stderr_progress, sync_state,
)
from .store import Store

_BAR_WIDTH = 28

# Код возврата «проект уже индексируется»: отличим от настоящего отказа (1).
EXIT_BUSY = 3
# Синк остановлен `ragsave cancel` — решение человека, не сбой; log-error.sh
# его не пишет.
EXIT_CANCELLED = 4

# Сколько `ragsave cancel` ждёт, пока синк дойдёт до конца батча и отпустит замок.
CANCEL_TIMEOUT = 60.0


class SyncCancelled(BaseException):
    """SIGTERM от `ragsave cancel`. BaseException — чтобы обработчики ошибок
    отдельного файла не проглотили отмену как сбой чтения."""


def _raise_cancelled(signum: int, frame: object) -> None:
    raise SyncCancelled


def _make_bar(min_interval: float = 0.1, elapsed_before: float = 0.0):
    """Однострочный прогресс-бар с перезаписью через \\r вместо скролла.

    done/total — файлы (доля не меняется во время эмбеддинга уже поставленного
    в очередь батча — двигается только текст детали). min_interval ограничивает
    частоту перерисовки: без этого печать на каждый под-батч из EMBED_SUB_BATCH
    фрагментов на быстрых файлах может мелькать чаще, чем терминал успевает
    отрисовать, и тратить время на саму печать, а не на индексацию.
    elapsed_before — сколько чужой синк уже шёл до того, как его стали рисовать.
    """
    last = 0.0
    started = time.monotonic() - elapsed_before

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


def _watch_holder(paths: ProjectPaths, deadline: float) -> None:
    """Пока проект индексирует другой процесс — рисовать его прогресс-бар.

    Ход публикует сам держатель замка (.sync.progress), в том числе фоновый
    синк с --quiet; пока он не опубликован (грузится модель, держатель старой
    версии) — бар стоит на нуле с пояснением.
    """
    holder = lock_holder(paths.lock)
    if holder is None:
        return
    print(f"[ragsave] проект индексирует другой процесс ({holder}) — его ход:",
          file=sys.stderr)
    bar = _make_bar()
    shown = None
    try:
        while holder is not None and time.monotonic() < deadline:
            state = read_progress(paths.progress)
            if state is None:
                bar(0, 0, "ход ещё не опубликован, ждём")
            else:
                if state["started"] != shown:
                    shown = state["started"]
                    bar = _make_bar(elapsed_before=max(0.0, time.time() - shown))
                bar(state["done"], state["total"], state["detail"])
            time.sleep(0.5)
            holder = lock_holder(paths.lock)
    finally:
        bar.finish()


def _cmd_index(args: argparse.Namespace, force: bool) -> int:
    root = _root_or_exit(args.path)
    quiet = getattr(args, "quiet", False)
    progress = None if quiet else stderr_progress
    if not quiet:
        print(f"[ragsave] проект: {root}", file=sys.stderr)
        parallel = f", воркеров: {config.EMBED_PARALLEL}" if config.EMBED_PARALLEL else ""
        print(f"[ragsave] модель: {config.EMBED_MODEL} "
              f"(батч {config.EMBED_BATCH}{parallel})", file=sys.stderr)
    signal.signal(signal.SIGTERM, _raise_cancelled)
    wait = args.wait
    bar = None
    try:
        if wait > 0 and not quiet:
            deadline = time.monotonic() + wait
            try:
                _watch_holder(ProjectPaths(root=root), deadline)
            except KeyboardInterrupt:
                print("[ragsave] перестал смотреть; тот синк продолжает работу", file=sys.stderr)
                return EXIT_BUSY
            wait = max(0.0, deadline - time.monotonic())
        bar = None if quiet else _make_bar()
        report = index_project(
            root=root, force=force, progress=progress, tick=bar,
            lock_wait=wait,
        )
    except SyncInProgress as exc:
        print(f"ragsave: {exc}", file=sys.stderr)
        if not quiet:
            if exc.pid is not None:
                print(f"[ragsave] жив ли он: ps -o pid,etime,cmd -p {exc.pid}", file=sys.stderr)
            print(f"[ragsave] итог фонового синка появится в {ProjectPaths(root=root).sync_log}; "
                  f"смотреть его ход: ragsave sync --wait 600; остановить: ragsave cancel",
                  file=sys.stderr)
        return EXIT_BUSY
    except (SyncCancelled, KeyboardInterrupt):
        if bar is not None:
            bar.finish()
            bar = None
        print("ragsave: синк отменён; изменения подхватит следующий синк", file=sys.stderr)
        return EXIT_CANCELLED
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
        mismatch = store.model_mismatch(embedder.model_name, embedder.engine_version)
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


def _cmd_cancel(args: argparse.Namespace) -> int:
    """Остановить идущий синк проекта: SIGTERM держателю замка.

    Синк пишет индекс короткими транзакциями, поэтому остановка ничего не
    портит: следующий синк продолжит с файлов, которые не успели записаться.
    rag_index внутри MCP-сервера не трогаем — SIGTERM убил бы сам сервер.
    """
    root = _root_or_exit(args.path)
    paths = ProjectPaths(root=root)
    holder = lock_holder(paths.lock)
    if holder is None:
        print("[ragsave] синк не идёт — отменять нечего", file=sys.stderr)
        return 0
    pid = holder_pid(holder)
    command = subprocess.run(
        ["ps", "-o", "args=", "-p", str(pid)], capture_output=True, text=True,
    ).stdout.strip() if pid is not None else ""
    if "ragsave" not in command or command.endswith(" serve"):
        print(f"ragsave: замок держит не CLI-синк ({holder}: {command or 'процесс не найден'}) — "
              f"не останавливаю; rag_index внутри MCP-сервера закончится сам", file=sys.stderr)
        return 1
    try:
        os.kill(pid, signal.SIGTERM)
    except ProcessLookupError:
        print("[ragsave] синк уже закончился", file=sys.stderr)
        return 0
    print(f"[ragsave] остановка синка ({holder}): ждём конца текущего батча", file=sys.stderr)
    deadline = time.monotonic() + CANCEL_TIMEOUT
    while lock_holder(paths.lock) is not None:
        if time.monotonic() >= deadline:
            print(f"ragsave: синк не остановился за {CANCEL_TIMEOUT:.0f}с; "
                  f"принудительно: kill -9 {pid}", file=sys.stderr)
            return 1
        time.sleep(0.5)
    print("[ragsave] синк остановлен; запустить заново: ragsave sync", file=sys.stderr)
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
            help="ждать до СЕК секунд, если проект уже индексирует другой процесс, "
                 "и показывать его ход (по умолчанию не ждать и выйти с кодом 3)",
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

    cancel = sub.add_parser("cancel", help="остановить идущий синк проекта")
    cancel.add_argument("path", nargs="?", help="путь к проекту")

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
        case "cancel":
            return _cmd_cancel(args)
        case "serve":
            return _cmd_serve(args)
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
