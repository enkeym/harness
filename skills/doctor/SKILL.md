---
name: doctor
description: "Diagnose Codex harness installation, hooks and MCP when the user reports a problem."
---

# doctor

Run ~/.config/harness/repo/install.sh --check, codex --version and codex mcp list. Harness PreToolUse routes search through MCP; SessionStart/Stop warm and sync existing RAG indexes. Inspect index logs under ~/.ai-hooks/logs only for indexing failures. For a user or project hook, inspect its handler, /hooks trust and duplicate inline definitions; consult current official hook documentation before changing its protocol. Reproduce failures with isolated input. Fix repository sources, preserve user config and run relevant tests. Never print credentials.
