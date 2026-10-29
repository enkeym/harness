---
name: doctor
description: "Diagnose Codex harness installation, hooks and MCP when the user reports a problem."
---

# doctor

Run ~/.config/harness/repo/install.sh --check, codex --version and codex mcp list. Harness global hooks are empty. Inspect index logs under ~/.ai-hooks/logs only for indexing failures. For an explicitly configured project hook, inspect its handler, /hooks trust and duplicate inline definitions; consult current official hook documentation before changing its protocol. Reproduce failures with isolated input. Fix repository sources, preserve user config and run relevant tests. Never print credentials.
