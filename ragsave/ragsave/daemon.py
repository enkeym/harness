"""Общий демон модели: одна загруженная модель на машину.

У каждой сессии свой MCP-сервер, и без демона каждый грузил бы свою копию
e5-large (1,5 ГБ, 5–45 с на загрузку). Демон слушает unix-сокет; клиент —
Embedder: демона нет — синк считает сам, поиск поднимает демон; демон
подвёл — одна повторная попытка, дальше DaemonFailed.

Протокол — по JSON-строке, одно соединение на запрос:
{"v":2,"model":…,"engine":…,"kind":"query"|"passage","texts":[…]} →
ноль и больше {"tick":1} (пульс синку: демон досчитал кусок, свой или чужой),
затем {"vectors":[…]} или {"error":…} (с "refused": true — демон держит
другую модель или версию fastembed).

Демон поднимают только процессы с обычным приоритетом — поиск (embed_query)
и прогрев `ragsave warm` из хука SessionStart (до nice). Синк из хука идёт
под nice 19, и поднятый им демон унаследовал бы приоритет.

Код пакета живой (симлинк в дерево harness): демон, заметив правку своих
.py, выходит при первой паузе — следующий запрос поднимет демон со свежим кодом.
"""

from __future__ import annotations

import fcntl
import json
import os
import socket
import socketserver
import subprocess
import sys
import threading
import time
import traceback
from pathlib import Path
from typing import Any, Callable

from . import config

PROTOCOL = 2
TICK = b'{"tick": 1}\n'


class DaemonUnavailable(Exception):
    """Демон не ответил: таймаут, обрыв, ошибка внутри демона."""


class DaemonDown(DaemonUnavailable):
    """К сокету не подключиться: демона нет."""


class DaemonRefused(DaemonUnavailable):
    """Демон держит другую модель или версию fastembed: до его выхода не спрашивать."""


class DaemonFailed(RuntimeError):
    """Демон подвёл и после повторной попытки: вызов падает, своей модели не грузит."""


def _lock_path(sock: Path) -> Path:
    return sock.with_suffix(".lock")


def _log_path(sock: Path) -> Path:
    return sock.parent / "daemon.log"


def log_path() -> Path:
    return _log_path(Path(config.DAEMON_SOCKET))


# ---------- клиент ----------


def _connect(timeout: float) -> socket.socket:
    conn = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    conn.settimeout(timeout)
    try:
        conn.connect(config.DAEMON_SOCKET)
    except OSError as exc:
        conn.close()
        raise DaemonDown(f"{type(exc).__name__}: {exc}") from None
    return conn


def request(kind: str, texts: list[str], model: str, engine: str) -> list[list[float]]:
    """Векторы от демона в порядке texts.

    Поиску таймаут — на весь ответ, синку — на тишину между пульсами.
    """
    payload = json.dumps(
        {"v": PROTOCOL, "model": model, "engine": engine, "kind": kind, "texts": texts},
        ensure_ascii=False,
    ).encode("utf-8") + b"\n"
    timeout = config.DAEMON_QUERY_TIMEOUT if kind == "query" else config.DAEMON_IDLE_TIMEOUT
    with _connect(timeout) as conn:
        try:
            conn.sendall(payload)
            with conn.makefile("rb") as reader:
                line = reader.readline()
                while line == TICK:
                    line = reader.readline()
        except OSError as exc:
            raise DaemonUnavailable(f"{type(exc).__name__}: {exc}") from None
    if not line:
        raise DaemonUnavailable("демон закрыл соединение без ответа")
    try:
        answer = json.loads(line)
    except ValueError:
        raise DaemonUnavailable("ответ демона — не JSON") from None
    if "error" in answer:
        raise (DaemonRefused if answer.get("refused") else DaemonUnavailable)(answer["error"])
    vectors = answer.get("vectors")
    if not isinstance(vectors, list) or len(vectors) != len(texts):
        raise DaemonUnavailable("демон вернул не столько векторов, сколько текстов")
    return vectors


def _rotate_log(log: Path) -> None:
    """Лог крупнее DAEMON_LOG_LIMIT — в log.1 (прежний .1 теряется)."""
    try:
        if log.stat().st_size > config.DAEMON_LOG_LIMIT:
            log.replace(log.with_name(log.name + ".1"))
    except OSError:
        pass  # лога нет или не переименовать — пишем в тот, что есть


def _spawn(warm: bool = False) -> None:
    """Запустить `python -m ragsave daemon` отдельной сессией, вывод — в daemon.log."""
    sock = Path(config.DAEMON_SOCKET)
    sock.parent.mkdir(parents=True, exist_ok=True)
    env = dict(os.environ)
    package_root = str(Path(__file__).resolve().parents[1])
    env["PYTHONPATH"] = os.pathsep.join(filter(None, [package_root, env.get("PYTHONPATH")]))
    env["RAGSAVE_DAEMON_SOCKET"] = str(sock)
    log_file = _log_path(sock)
    _rotate_log(log_file)
    with log_file.open("ab") as log:
        subprocess.Popen(
            [sys.executable, "-m", "ragsave", "daemon", *(["--warm"] if warm else [])],
            cwd=str(sock.parent), env=env, stdin=subprocess.DEVNULL,
            stdout=log, stderr=subprocess.STDOUT, start_new_session=True,
        )


def start(warm: bool = False) -> bool:
    """Поднять демон и дождаться его сокета. False — не дождались.

    warm — демон грузит модель сразу, не дожидаясь первого запроса.
    """
    try:
        _spawn(warm)
    except OSError:
        return False
    deadline = time.monotonic() + config.DAEMON_START_WAIT
    while time.monotonic() < deadline:
        try:
            _connect(1.0).close()
            return True
        except DaemonDown:
            time.sleep(0.05)
    return False


def warm() -> bool:
    """Прогрев: демон жив — ничего не делать, нет — поднять его с моделью.

    Зовёт хук SessionStart с обычным приоритетом, до синка под nice: первый
    поиск сессии не ждёт загрузку модели (5–45 с). False — сокет не поднялся.
    """
    try:
        _connect(1.0).close()
        return True
    except DaemonDown:
        return start(warm=True)


def log_fallback(reason: str) -> None:
    """Одна строка в общий лог ошибок: демон подвёл, вызов считает своя модель.

    Лог никогда не должен ронять поиск — отсюда молчаливый except.
    """
    try:
        path = config.errors_log()
        path.parent.mkdir(parents=True, exist_ok=True)
        stamp = time.strftime("%Y-%m-%d %H:%M:%S")
        with path.open("a", encoding="utf-8") as handle:
            handle.write(f"[{stamp}] ragsave daemon | {os.getcwd()} | {reason} "
                         f"— модель своя\n")
    except OSError:
        pass


# ---------- сервер ----------


class _Engine:
    """Одна модель и один замок на инференцию.

    Поиск идёт вперёд синка: пачка синка не берёт модель, пока ждёт хоть один
    запрос поиска, а свою пачку демон считает кусками по DAEMON_INFER_BATCH —
    поиск ждёт не дольше одного куска. tick — пульс клиенту синка: после
    каждого досчитанного куска, своего или чужого; ушедший клиент обрывает свою
    пачку на ближайшем пульсе (OSError).
    """

    def __init__(self, embedder: Any) -> None:
        self.embedder = embedder
        self._cond = threading.Condition()
        self._busy = False
        self._queries = 0
        self._clock = threading.Lock()
        self._active = 0
        self._last = time.monotonic()

    def _run(
        self, query: bool, compute: Callable[[], list[list[float]]],
        tick: Callable[[], None] | None = None,
    ) -> list[list[float]]:
        with self._cond:
            if query:
                self._queries += 1
            while self._busy or (not query and self._queries):
                self._cond.wait()
                if tick is not None:
                    # Пульс пишется без замка: медленный клиент не держит очередь.
                    self._cond.release()
                    try:
                        tick()
                    finally:
                        self._cond.acquire()
            if query:
                self._queries -= 1
            self._busy = True
        try:
            return compute()
        finally:
            with self._cond:
                self._busy = False
                self._cond.notify_all()

    def embed(
        self, kind: str, texts: list[str], tick: Callable[[], None] | None = None
    ) -> list[list[float]]:
        if kind == "query":
            return self._run(True, lambda: [self.embedder.embed_query(t) for t in texts])
        # Куски — из фрагментов близкой длины: ONNX дополняет кусок до самого
        # длинного. Замер на e5-large, 64 фрагмента: 92 → 63 с, векторы те же.
        order = sorted(range(len(texts)), key=lambda i: len(texts[i]))
        vectors: list[list[float]] = [[] for _ in texts]
        step = config.DAEMON_INFER_BATCH
        for start in range(0, len(order), step):
            part = order[start:start + step]
            done = self._run(
                False, lambda: self.embedder.embed_passages([texts[i] for i in part]), tick
            )
            for index, vector in zip(part, done):
                vectors[index] = vector
            if tick is not None and start + step < len(order):
                tick()
        return vectors

    def answer(
        self, line: bytes, tick: Callable[[], None] | None = None
    ) -> dict[str, Any]:
        try:
            req = json.loads(line)
        except ValueError:
            return {"error": "запрос — не JSON"}
        model, engine = self.embedder.model_name, self.embedder.engine_version
        if (req.get("v"), req.get("model"), req.get("engine")) != (PROTOCOL, model, engine):
            return {"error": f"демон держит {model} (fastembed {engine}, протокол "
                             f"{PROTOCOL})", "refused": True}
        kind, texts = req.get("kind"), req.get("texts")
        if kind not in ("query", "passage") or not isinstance(texts, list):
            return {"error": "в запросе нет kind или texts"}
        try:
            return {"vectors": self.embed(kind, [str(t) for t in texts], tick)}
        except OSError:
            raise  # клиент ушёл — отвечать некому
        except Exception as exc:  # noqa: BLE001 — демон отвечает отказом, а не падает
            traceback.print_exc()
            return {"error": f"{type(exc).__name__}: {exc}"}

    def warm(self) -> None:
        """Загрузить модель до первого запроса. Под замком инференции: поиск,
        пришедший во время загрузки, ждёт её, а не грузит вторую копию.
        Пока грузится, демон не простаивает — простой считается от конца загрузки.
        """
        self.enter()
        try:
            self._run(False, lambda: self.embedder.warmup() or [])
        finally:
            self.leave()

    def enter(self) -> None:
        with self._clock:
            self._active += 1

    def leave(self) -> None:
        with self._clock:
            self._active -= 1
            self._last = time.monotonic()

    def idle_for(self) -> float:
        with self._clock:
            return 0.0 if self._active else time.monotonic() - self._last


class _Handler(socketserver.StreamRequestHandler):
    def handle(self) -> None:
        engine: _Engine = self.server.engine  # type: ignore[attr-defined]
        engine.enter()
        try:
            reply = engine.answer(self.rfile.readline(), lambda: self.wfile.write(TICK))
            self.wfile.write(json.dumps(reply).encode("utf-8") + b"\n")
        except OSError:
            pass  # клиент ушёл, не дождавшись: его вызов повторит запрос или упадёт
        finally:
            engine.leave()


class _Server(socketserver.ThreadingMixIn, socketserver.UnixStreamServer):
    pass


def _say(message: str) -> None:
    print(f"[{time.strftime('%Y-%m-%d %H:%M:%S')}] [{os.getpid()}] {message}", flush=True)


def _take_lock(lock: Any) -> bool:
    """Замок демона. Держит живой демон — False; держит выходящий по простою
    (сокет уже убран) — дождаться его ухода: иначе клиент, поднявший
    нас в этот момент, остался бы без демона.
    """
    deadline = time.monotonic() + config.DAEMON_START_WAIT
    while True:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            return True
        except OSError:
            pass
        if time.monotonic() >= deadline:
            return False
        try:
            _connect(1.0).close()
            return False
        except DaemonDown:
            time.sleep(0.05)


def _code_stamp() -> float:
    """Свежайшая правка .py пакета: изменилась — демон держит устаревший код."""
    stamps = [0.0]
    for path in Path(__file__).resolve().parent.glob("*.py"):
        try:
            stamps.append(path.stat().st_mtime)
        except OSError:
            pass
    return max(stamps)


def serve(embedder: Any = None, idle: float | None = None, warm: bool = False) -> int:
    """Слушать сокет до простоя в idle секунд (0 — всегда) или до правки кода
    пакета; второй экземпляр выходит сразу.

    Модель грузится первым запросом (warm — сразу после подъёма сокета): сокет
    поднят сразу, и клиент, поднявший демон, ждёт загрузку здесь, а не грузит
    вторую копию у себя.
    """
    sock = Path(config.DAEMON_SOCKET)
    sock.parent.mkdir(parents=True, exist_ok=True)
    idle = config.IDLE_UNLOAD if idle is None else idle
    lock = _lock_path(sock).open("a")
    try:
        if not _take_lock(lock):
            _say("демон уже запущен — выхожу")
            return 0
        if embedder is None:
            from .embedder import Embedder

            embedder = Embedder(use_daemon=False)
        # Сокет под замком может остаться только от упавшего демона.
        sock.unlink(missing_ok=True)
        server = _Server(str(sock), _Handler)
        server.engine = _Engine(embedder)  # type: ignore[attr-defined]
        os.chmod(sock, 0o600)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        _say(f"слушаю {sock}: {embedder.model_name}, простой до выхода {idle or '∞'} с")
        engine: _Engine = server.engine  # type: ignore[attr-defined]
        stamp = _code_stamp()
        if warm:
            begun = time.monotonic()
            try:
                engine.warm()
                _say(f"модель загружена за {time.monotonic() - begun:.0f} с")
            except Exception:  # noqa: BLE001 — не прогрелись: модель загрузит первый запрос
                traceback.print_exc()
        while True:
            time.sleep(min(1.0, idle / 4) if idle else 1.0)
            quiet = engine.idle_for()
            if idle and quiet >= idle:
                reason = "простой — выход"
                break
            if quiet > 0 and _code_stamp() != stamp:
                reason = "код ragsave обновился — выход, следующий запрос поднимет свежий демон"
                break
        # Сначала сокет, потом shutdown: новый клиент получает DaemonDown и поднимает
        # свежий демон (тот ждёт замок в _take_lock), а не пустой ответ из backlog.
        # Уже стоящие в backlog получат обрыв и повторят запрос уже без сокета.
        sock.unlink(missing_ok=True)
        server.shutdown()
        server.server_close()
        _say(reason)
        return 0
    finally:
        lock.close()
