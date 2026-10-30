---
paths:
  - "bin/ragsave-venv.sh"
  - "bin/codex-install.mjs"
  - "ai-hooks/bin/ragsave-sync.sh"
  - "ai-hooks/bin/mcp-serve.sh"
  - "ragsave/ragsave/config.py"
  - "ragsave/ragsave/indexer.py"
  - "ragsave/ragsave/server.py"
  - "ragsave/ragsave/cli.py"
  - "ragsave/ragsave/daemon.py"
  - "ragsave/ragsave/embedder.py"
  - "ragsave/tests/test_ragsave.py"
  - "ragsave/tests/test_regressions.py"
  - "ai-hooks/test/test-ragsave-sync.mjs"
  - "ai-hooks/test/test-mcp-serve.mjs"
---

## Корень и состояние индекса
`ragsave/ragsave/config.py:ProjectPaths` задаёт `.ragsave/rag.db`, lock и `.ragsave-disable`; `ragsave/ragsave/server.py`, `ragsave/ragsave/indexer.py`, `ragsave/ragsave/cli.py` и `ragsave/ragsave/daemon.py` используют эти пути, а `ai-hooks/bin/ragsave-sync.sh` и `ai-hooks/bin/mcp-serve.sh` выбирают индекс для hooks и MCP. При смене маркеров или правил ближайшего корня проверять `ragsave/tests/test_ragsave.py`, `ragsave/tests/test_regressions.py`, `ai-hooks/test/test-ragsave-sync.mjs` и `ai-hooks/test/test-mcp-serve.mjs`.

## Установка среды
`bin/ragsave-venv.sh` и `bin/codex-install.mjs:ragHome` используют `RAGSAVE_HOME`, который читает `ragsave/ragsave/config.py:RAGSAVE_HOME`; при изменении каталога согласованно обновлять оба установочных пути и запускать `install.sh --check` вместе с Python-наборами RAG Save.
