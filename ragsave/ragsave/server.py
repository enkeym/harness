"""MCP-сервер ragsave: смысловой поиск по проекту.

Дополняет tokensave, не заменяет его: tokensave отвечает на структурные
вопросы (кто вызывает функцию, что сломается при правке), ragsave — на
смысловые («где описан деплой», «что за переменная окружения для почты»),
включая файлы, которых в графе кода нет вовсе.

API mcp 2.0: обработчики передаются в Server как on_list_tools / on_call_tool.
"""

from __future__ import annotations

import asyncio
import json
import os
import time
import traceback
from pathlib import Path
from typing import Any

import mcp.types as types
from mcp.server import Server
from mcp.server.stdio import stdio_server

from . import config
from .config import ProjectPaths, find_project_root
from .embedder import Embedder
from .indexer import SyncInProgress, index_project, sync_state
from .store import Store

SERVER_NAME = "ragsave"
SERVER_VERSION = "1.0.0"

INSTRUCTIONS = (
    "ragsave — смысловой (векторный + полнотекстовый) поиск по всем файлам "
    "проекта, включая те, что не попадают в структурный индекс tokensave: "
    "документацию, json/yaml-конфиги, миграции, .env-примеры, SQL. "
    "Используй rag_search, когда не знаешь точного имени символа и ищешь по "
    "смыслу или формулировке. Для структурных вопросов по коду (символы, "
    "вызовы, зависимости) используй tokensave."
)

# Один энкодер на процесс: модель весит гигабайты, повторная загрузка недопустима.
_embedder = Embedder()


def _resolve_root(raw: str | None) -> Path:
    root = find_project_root(raw or os.getcwd())
    if root is None:
        raise ValueError(
            "не удалось определить корень проекта — передайте параметр project "
            "с путём к репозиторию"
        )
    return root


def _text(payload: Any) -> types.CallToolResult:
    body = payload if isinstance(payload, str) else json.dumps(
        payload, ensure_ascii=False, indent=2
    )
    return types.CallToolResult(content=[types.TextContent(type="text", text=body)])


def _error(message: str) -> types.CallToolResult:
    return types.CallToolResult(
        content=[types.TextContent(type="text", text=f"ragsave: {message}")],
        isError=True,
    )


def _log_failure(tool: str, exc: BaseException) -> None:
    """Записать неожиданный отказ в общий лог tokensave/ragsave.

    Пишем только исключения, а не штатные отказы вроде «индекс не построен»:
    лог нужен для разбора багов, и мусор в нём обесценивает его же.
    Сам лог никогда не должен ронять инструмент — отсюда молчаливый except.
    """
    try:
        log_dir = Path(
            os.environ.get("AI_HOOKS_LOG_DIR", Path.home() / ".ai-hooks" / "logs")
        )
        log_dir.mkdir(parents=True, exist_ok=True)
        stamp = time.strftime("%Y-%m-%d %H:%M:%S")
        with (log_dir / "errors.log").open("a", encoding="utf-8") as handle:
            handle.write(
                f"[{stamp}] ragsave mcp {tool} | {os.getcwd()} | "
                f"{type(exc).__name__}: {exc}\n"
            )
            handle.write("".join(f"    {line}\n" for line in
                                 traceback.format_exc().splitlines()[-12:]))
            handle.write("---\n")
    except OSError:
        pass


TOOLS: list[types.Tool] = [
    types.Tool(
        name="rag_search",
        description=(
            "Смысловой поиск по файлам проекта (гибрид: векторная близость + "
            "точные слова). Возвращает фрагменты с путями и номерами строк. "
            "Подходит для вопросов на естественном языке: 'как настроен CI', "
            "'где описаны переменные окружения для почты'. Для точных имён "
            "символов в коде эффективнее tokensave_search."
        ),
        inputSchema={
            "type": "object",
            "properties": {
                "query": {
                    "type": "string",
                    "description": "Запрос на естественном языке или ключевые слова",
                },
                "limit": {
                    "type": "integer",
                    "description": "Сколько фрагментов вернуть (по умолчанию 8)",
                    "default": 8,
                },
                "path_include": {
                    "type": "array",
                    "items": {"type": "string"},
                    "description": "Оставить только пути, содержащие эти подстроки",
                },
                "path_exclude": {
                    "type": "array",
                    "items": {"type": "string"},
                    "description": "Исключить пути, содержащие эти подстроки",
                },
                "only_outside_tokensave": {
                    "type": "boolean",
                    "description": (
                        "Искать только там, куда tokensave не заглядывает: "
                        "доки, конфиги, миграции. По умолчанию false"
                    ),
                    "default": False,
                },
                "project": {
                    "type": "string",
                    "description": "Путь к проекту (по умолчанию текущий каталог)",
                },
            },
            "required": ["query"],
        },
        # Claude Code держит инструменты MCP в deferred, пока модель не загрузит
        # их через ToolSearch. tokensave свои основные помечает этой меткой, и
        # без неё rag_search проигрывал ему выбор ещё до первого вызова.
        _meta={"anthropic/alwaysLoad": True},
    ),
    types.Tool(
        name="rag_status",
        description=(
            "Состояние смыслового индекса проекта: сколько файлов и фрагментов, "
            "какая модель, размер БД, сколько файлов вне покрытия tokensave."
        ),
        inputSchema={
            "type": "object",
            "properties": {
                "project": {
                    "type": "string",
                    "description": "Путь к проекту (по умолчанию текущий каталог)",
                }
            },
        },
    ),
    types.Tool(
        name="rag_index",
        description=(
            "Построить или обновить смысловой индекс. Инкрементально: "
            "неизменённые файлы пропускаются. Обычно вызывается автоматически "
            "хуком, вручную нужен для первичной индексации или после смены модели."
        ),
        inputSchema={
            "type": "object",
            "properties": {
                "project": {
                    "type": "string",
                    "description": "Путь к проекту (по умолчанию текущий каталог)",
                },
                "force": {
                    "type": "boolean",
                    "description": "Перестроить индекс с нуля (нужно при смене модели)",
                    "default": False,
                },
            },
        },
    ),
]


async def on_list_tools(
    ctx: Any, params: types.PaginatedRequestParams | None
) -> types.ListToolsResult:
    return types.ListToolsResult(tools=TOOLS)


async def on_call_tool(
    ctx: Any, params: types.CallToolRequestParams
) -> types.CallToolResult:
    name = params.name
    args = params.arguments or {}
    try:
        if name == "rag_search":
            return await asyncio.to_thread(_do_search, args)
        if name == "rag_status":
            return await asyncio.to_thread(_do_status, args)
        if name == "rag_index":
            return await asyncio.to_thread(_do_index, args)
        return _error(f"неизвестный инструмент: {name}")
    except (ValueError, SyncInProgress) as exc:
        # Плохой ввод и занятый проект — штатные отказы, не баги: в лог не идут.
        return _error(str(exc))
    except Exception as exc:  # noqa: BLE001 — наружу отдаём текст, сервер не роняем
        _log_failure(name, exc)
        return _error(str(exc))


def _do_search(args: dict[str, Any]) -> types.CallToolResult:
    root = _resolve_root(args.get("project"))
    paths = ProjectPaths(root=root)
    if not paths.db.exists():
        return _error(
            f"индекс для {root} не построен. Выполните rag_index "
            f"или в терминале: ragsave init"
        )

    query = str(args.get("query") or "").strip()
    if not query:
        return _error("пустой запрос")

    with Store(paths.db) as store:
        mismatch = store.model_mismatch(_embedder.model_name)
        if mismatch:
            return _error(mismatch)
        vector = _embedder.embed_query(query)
        hits = store.search(
            query_vector=vector,
            query_text=query,
            limit=int(args.get("limit") or 8),
            path_include=args.get("path_include"),
            path_exclude=args.get("path_exclude"),
            only_outside_tokensave=bool(args.get("only_outside_tokensave")),
        )

    note = _sync_note(paths)
    if not hits:
        blocks = [f"Ничего не найдено по запросу: {query}"]
    else:
        blocks = [f"Найдено фрагментов: {len(hits)} (проект: {root})", ""]
    for index, hit in enumerate(hits, start=1):
        marker = "" if hit.in_tokensave else "  [вне tokensave]"
        blocks.append(
            f"--- {index}. {hit.path}:{hit.start_line}-{hit.end_line}"
            f"  score={hit.score:.4f}{marker}"
        )
        blocks.append(hit.text)
        blocks.append("")
    if note:
        blocks.append(note)
    return _text("\n".join(blocks))


def _do_status(args: dict[str, Any]) -> types.CallToolResult:
    root = _resolve_root(args.get("project"))
    paths = ProjectPaths(root=root)
    if not paths.db.exists():
        return _text(
            {"project": str(root), "indexed": False,
             "hint": "индекс не построен, выполните rag_index"}
        )
    with Store(paths.db) as store:
        stats = store.stats()
    stats.update({"project": str(root), "indexed": True,
                  "current_model": _embedder.model_name})
    stats.update(sync_state(paths))
    return _text(stats)


def _sync_note(paths: ProjectPaths) -> str | None:
    """Строка к выдаче поиска, если индекс может отставать от файлов."""
    state = sync_state(paths)
    if state["autosync"] != "ok":
        return (f"ragsave: автосинк выключен ({config.DISABLE_MARK} в корне) — "
                f"индекс может отставать от файлов")
    if state["sync_in_progress"]:
        return "ragsave: идёт синхронизация индекса — свежих правок в выдаче может не быть"
    return None


def _do_index(args: dict[str, Any]) -> types.CallToolResult:
    root = _resolve_root(args.get("project"))
    report = index_project(
        root=root, embedder=_embedder, force=bool(args.get("force"))
    )
    result = report.as_dict()
    result["project"] = str(root)
    return _text(result)


async def main_async() -> None:
    server = Server(
        SERVER_NAME,
        version=SERVER_VERSION,
        instructions=INSTRUCTIONS,
        on_list_tools=on_list_tools,
        on_call_tool=on_call_tool,
    )
    async with stdio_server() as (read_stream, write_stream):
        await server.run(
            read_stream, write_stream, server.create_initialization_options()
        )


def main() -> None:
    asyncio.run(main_async())


if __name__ == "__main__":
    main()
