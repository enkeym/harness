---
name: python
description: "Python conventions — interpreter and checks, data shapes, exceptions, threads and locks, files and processes, platform-bound imports, pytest with monkeypatch and tmp_path. Load before writing, reviewing or testing Python code: a module, script, service, CLI, test, conftest or requirements file."
---

# Python conventions

The project outranks this list: copy a neighbouring module first. The
language-neutral sections of [../shared/code-rules.md](../shared/code-rules.md)
(reuse order, constants and config, naming, KISS/DRY, errors) apply as written —
`dependencies` there means `requirements.txt`/`pyproject.toml`, `node_modules`
the environment's `site-packages`, `npm view` → `pip index versions`. This file
adds what those rules miss.

## Interpreter and checks
- Run with the interpreter and runner the project's docs or CI name (a venv,
  a Windows `python.exe` from WSL, `uv run`), never a system `python3` that
  differs — other packages, other OS.
- Checks before a commit, in `review-standards` step 9: the full `pytest` once,
  plus the linter and type checker the project configures (`pyproject.toml`,
  `setup.cfg`, CI). None configured → `ruff check` on the touched files if
  installed, else `python -m pyflakes`, else one line saying so.
- No type checker run on unannotated code — its output is noise, not findings.
- A pinned requirement stays pinned; a bump comes with the check its comment
  names.

## Data shapes
- Annotate as the neighbours do; in unannotated code don't hint one function.
- A fixed-shape value passed between functions → `dataclass`, `NamedTuple` or
  `TypedDict` in the project's form, not a bare tuple or dict read by index.
  `'tuple' object has no attribute 'get'` is this bug.
- Findings: a mutable default (`def f(x=[])`), `is` against a literal, a
  closure in a loop binding the loop variable late.

## Exceptions
- `except Exception` only at a boundary that logs the traceback
  (`log.exception`) and keeps a loop, thread or request alive; elsewhere the
  specific exception. Bare `except:` also swallows `KeyboardInterrupt` — never.
- The user sees a sentence, the log gets the traceback; never `str(exc)` in UI.
- Translating an exception → `raise New(...) from exc`.

## Threads and shared state
- State written from more than one thread — a file, a log, a dict or list, a
  counter — gets one `Lock` per resource, held across the whole
  read-modify-write (`with lock:`). Find every writer by search, not only the
  one in the diff.
- A thread target catches and logs its own exceptions: an uncaught one kills
  the thread with a line on stderr nobody reads.
- Every `Thread` is `daemon=True` or joined on shutdown; every blocking wait
  has a timeout (`Event.wait(t)`, `queue.get(timeout=t)`, `join(t)`).
- Callbacks from a framework (GUI, tray, webview bridge, server handler) may
  each run on their own thread — treat them as concurrent.

## Files, processes, resources
- Every file, socket, handle and child process opened in `with` or closed in
  `finally`; long-lived handles closed on stop.
- Atomic write: a temp file in the same directory, `os.replace` onto the target.
  On Windows `os.replace` raises `PermissionError` (WinError 5/32) while another
  handle is open — writers share the lock, a temp name per writer.
- Text I/O with explicit `encoding="utf-8"`: below 3.15 the Windows default
  is the ANSI code page, and the code may still run there.
- `subprocess.run([...], timeout=..., check=...)` with an argument list;
  `shell=True` only for a fixed string.

## Platform-bound code
- `ctypes.WinDLL`, `win32*`, `winreg`, `msvcrt` loaded at first call, behind
  `sys.platform`, or by `lazy import` when the project requires 3.15+ — an
  eager module-level load breaks import on another OS, and with it
  every test importing the module.
- Tests run on the OS the code ships to, against the real packages from the
  requirements. No stub, `importorskip` or `skipif` added only so another OS's
  runner goes green — move the CI job instead.
- Windows paths in tests parsed with `ntpath`, not `os.path`.

## Tests (pytest)
- `test-conventions` *What to test*, *Running* and *Never* apply; its stack
  sections don't.
- `tests/test_<module>.py`, plain functions, bare `assert` on the value,
  shared fixtures in `conftest.py`, test names in the project's form.
- Boundaries through `monkeypatch` (env, clock, a function patched where it is
  looked up: `module.name`, not its origin), `tmp_path` for files, `caplog`
  for logs. Never the real service, network or OS settings of the dev machine.
- Focused run: `pytest tests/test_x.py -k name -q`.
- A test with threads waits on an `Event` or `join` with a timeout, never
  `time.sleep` to let it finish.
