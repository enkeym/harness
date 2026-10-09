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
# Уже не сужаем: в окне, где не влезают и 10 клеток, кадр просто обрезается.
_BAR_MIN_WIDTH = 10
# Короче деталь не показываем — обрывок в пару букв ничего не говорит.
_DETAIL_MIN = 10

# Код возврата «проект уже индексируется»: отличим от настоящего отказа (1).
EXIT_BUSY = 3
# Синк остановлен Ctrl+C или SIGTERM — решение человека, не сбой; log-error.sh
# его не пишет.
EXIT_CANCELLED = 4

# Сколько Ctrl+C наблюдателя ждёт, пока чужой синк дойдёт до конца батча
# и отпустит замок.
CANCEL_TIMEOUT = 60.0

_HOLDER_GONE = "[ragsave] тот синк уже закончился; свежие правки подхватит следующий синк"


class SyncCancelled(BaseException):
    """SIGTERM от наблюдателя, нажавшего Ctrl+C. BaseException — чтобы
    обработчики ошибок отдельного файла не проглотили отмену как сбой
    чтения."""


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

    Кадр не шире columns - 1: перенесённую строку \r не вернёт к началу, и
    верхние ряды каждого кадра остались бы на экране. Поэтому в узком окне
    сначала пропадает деталь, потом сужается полоска, в конце режется весь кадр.
    say(message) печатает строку-сообщение, стерев кадр, — иначе сообщение
    приклеилось бы к нему; следующий tick рисует кадр заново.
    """
    last = 0.0
    started = time.monotonic() - elapsed_before
    # На экране висит кадр без перевода строки.
    drawn = False

    def render(done: float, total: int, detail: str) -> None:
        nonlocal last, drawn
        now = time.monotonic()
        finishing = total > 0 and done >= total
        if not finishing and now - last < min_interval:
            return
        last = now

        fraction = 0.0 if total == 0 else min(1.0, done / total)
        elapsed = now - started
        pct = int(fraction * 100)
        # done дробный внутри батча (эмбеддинг файла ещё не дописан) — в счётчике
        # округляем вниз, чтобы не показывать "16/16" раньше, чем 16-й файл
        # реально попал в индекс.
        shown = min(total, int(done))

        limit = shutil.get_terminal_size(fallback=(100, 20)).columns - 1
        # shown дополнен до ширины total — иначе полоска сужалась бы по мере счёта.
        counters = f"] {pct:3d}% ({shown:>{len(str(total))}}/{total}) {elapsed:5.0f}с"
        width = max(_BAR_MIN_WIDTH,
                    min(_BAR_WIDTH, limit - len("[ragsave] [") - len(counters)))
        filled = int(round(width * fraction))
        line = f"[ragsave] [{'█' * filled}{'░' * (width - filled)}{counters}"
        room = limit - len(line) - 2
        if detail and room >= _DETAIL_MIN:
            line += "  " + (detail if len(detail) <= room else detail[:room - 1] + "…")
        sys.stderr.write(f"\r{line[:limit]}\033[K")
        sys.stderr.flush()
        drawn = True

    def say(message: str) -> None:
        nonlocal drawn
        if drawn:
            sys.stderr.write("\r\033[K")
            drawn = False
        stderr_progress(message)

    def finish() -> None:
        """Оставить последний кадр на экране и перейти на новую строку."""
        nonlocal drawn
        if drawn:
            sys.stderr.write("\n")
            sys.stderr.flush()
            drawn = False

    render.say = say  # type: ignore[attr-defined]
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


def _watch_one(paths: ProjectPaths, holder: str) -> str | None:
    """Рисовать ход держателя holder, пока замок держит он; вернуть следующего.

    Ход публикует сам держатель (.sync.progress), в том числе фоновый синк
    с --quiet; пока он не опубликован (грузится модель, держатель старой версии)
    — бар стоит на нуле с пояснением. Ход чужого PID — остаток прошлого синка.
    """
    print(f"[ragsave] проект индексирует другой процесс ({holder}) — его ход "
          f"(Ctrl+C остановит его):", file=sys.stderr)
    pid = holder_pid(holder)
    bar = _make_bar()
    shown = None

    def draw() -> None:
        nonlocal bar, shown
        state = read_progress(paths.progress)
        if state is None or (pid is not None and state.get("pid") != pid):
            if shown is None:
                bar(0, 0, "ход ещё не опубликован, ждём")
            return
        if state["started"] != shown:
            shown = state["started"]
            bar = _make_bar(elapsed_before=max(0.0, time.time() - shown))
        bar(state["done"], state["total"], state["detail"])

    try:
        current: str | None = holder
        while current == holder:
            draw()
            time.sleep(0.5)
            current = lock_holder(paths.lock)
        # Закончивший синк оставляет последний кадр в файле хода: без этого
        # бар застыл бы на кадре, пойманном последним опросом.
        draw()
        return current
    finally:
        bar.finish()


def _watch_holder(paths: ProjectPaths) -> bool:
    """Пока проект индексируют другие процессы — рисовать их ход, без лимита.

    Ждёт, пока замок не освободится совсем: взял его следом хук — рисует
    уже его ход. Отметку .sync.again не ставит: свежие правки подхватит
    собственный проход, и повтор у держателя был бы лишним. True — ждал.
    """
    holder = lock_holder(paths.lock)
    watched = holder is not None
    while holder is not None:
        holder = _watch_one(paths, holder)
    return watched


def _stop_holder(paths: ProjectPaths) -> int:
    """Ctrl+C наблюдателя: остановить идущий синк — SIGTERM держателю замка.

    Синк пишет индекс короткими транзакциями, поэтому остановка ничего не
    портит: следующий синк продолжит с файлов, которые не успели записаться.
    rag_index внутри MCP-сервера не трогаем — SIGTERM убил бы сам сервер.
    """
    holder = lock_holder(paths.lock)
    if holder is None:
        print(_HOLDER_GONE, file=sys.stderr)
        return EXIT_CANCELLED
    pid = holder_pid(holder)
    command = subprocess.run(
        ["ps", "-o", "args=", "-p", str(pid)], capture_output=True, text=True,
    ).stdout.strip() if pid is not None else ""
    if "ragsave" not in command or command.endswith(" serve"):
        print(f"[ragsave] перестал смотреть; замок держит не CLI-синк "
              f"({holder}: {command or 'процесс не найден'}) — не останавливаю; "
              f"rag_index внутри MCP-сервера закончится сам", file=sys.stderr)
        return EXIT_BUSY
    try:
        os.kill(pid, signal.SIGTERM)
    except ProcessLookupError:
        print(_HOLDER_GONE, file=sys.stderr)
        return EXIT_CANCELLED
    print(f"[ragsave] остановка синка ({holder}): ждём конца текущего батча",
          file=sys.stderr)
    deadline = time.monotonic() + CANCEL_TIMEOUT
    while lock_holder(paths.lock) == holder:
        if time.monotonic() >= deadline:
            print(f"ragsave: синк не остановился за {CANCEL_TIMEOUT:.0f}с; "
                  f"принудительно: kill -9 {pid}", file=sys.stderr)
            return 1
        time.sleep(0.5)
    print("ragsave: синк отменён; изменения подхватит следующий синк", file=sys.stderr)
    return EXIT_CANCELLED


def _cmd_index(args: argparse.Namespace, force: bool) -> int:
    root = _root_or_exit(args.path)
    paths = ProjectPaths(root=root)
    quiet = getattr(args, "quiet", False)
    if not quiet:
        print(f"[ragsave] проект: {root}", file=sys.stderr)
        parallel = f", воркеров: {config.EMBED_PARALLEL}" if config.EMBED_PARALLEL else ""
        print(f"[ragsave] модель: {config.EMBED_MODEL} "
              f"(батч {config.EMBED_BATCH}{parallel})", file=sys.stderr)
    signal.signal(signal.SIGTERM, _raise_cancelled)
    bar = None
    try:
        while True:
            if not quiet:
                try:
                    watched = _watch_holder(paths)
                except KeyboardInterrupt:
                    return _stop_holder(paths)
                if watched:
                    print("[ragsave] тот синк закончился — свой проход по свежим правкам",
                          file=sys.stderr)
            bar = None if quiet else _make_bar()
            try:
                report = index_project(
                    root=root, force=force, progress=None if bar is None else bar.say,
                    tick=bar,
                )
                break
            except SyncInProgress:
                # Хук взял замок между пробой и попыткой — смотреть уже его ход, а не
                # ждать молча. Хуку (--quiet) — мгновенный EXIT_BUSY.
                if quiet:
                    raise
    except SyncInProgress as exc:
        print(f"ragsave: {exc}", file=sys.stderr)
        return EXIT_BUSY
    except (SyncCancelled, KeyboardInterrupt):
        if bar is not None:
            bar.finish()
        print("ragsave: синк отменён; изменения подхватит следующий синк", file=sys.stderr)
        return EXIT_CANCELLED
    except RuntimeError as exc:
        if bar is not None:
            bar.finish()
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
        node.add_argument(
            "--quiet", action="store_true",
            help="без прогресса; если проект уже индексируется — сразу выйти с кодом 3 "
                 "(без него — показать ход идущего синка и пройти после него)",
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
