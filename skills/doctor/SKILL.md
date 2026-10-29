---
name: doctor
description: "Diagnose Codex harness installation, hooks and MCP when the user reports a problem."
---

# doctor

Run ~/.config/harness/repo/install.sh --check, codex --version and codex mcp list.
Harness has only SessionStart/Stop for background RAG sync; search routing is
guidance. Inspect .ragsave/sync.log and ~/.ai-hooks/logs/errors.log on failures.
Check actual MCP requests and index freshness; installed files and autosync=ok
do not prove hooks executed. Distinguish sandbox, network and authentication
errors; reuse existing authorization, never ask for login on a filesystem error.
Reproduce failures with isolated input, preserve user config and run focused tests.
Never print credentials. Consult official hook docs only when changing its protocol.
