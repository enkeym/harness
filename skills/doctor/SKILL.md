---
name: doctor
description: "Diagnose Codex harness installation, missing or unused skills, hooks, MCP and index health when the user reports a problem or requests an audit."
---

# doctor

Run ~/.config/harness/repo/install.sh --check, codex --version and codex mcp list.
For a skills audit, compare ~/.config/harness/repo/skills/*/SKILL.md with ~/.agents/skills
links, the hand-made Qwen mirror ~/.qwen/skills (install.sh --check does not cover it —
flag links whose target is gone) and the session's available-skills catalog; inspect
workflow triggers, relative references and required helpers. shared/ is reference material.
Use codex doctor --json for native diagnostics when needed; keep its report
local and quote only relevant redacted checks. It does not prove hook execution.
Harness has only SessionStart/Stop for background RAG sync; search routing is
guidance. Inspect .ragsave/sync.log and ~/.ai-hooks/logs/errors.log on failures.
Check actual MCP requests and index freshness; installed files and autosync=ok
do not prove hooks executed. Distinguish sandbox, network and authentication
errors; reuse existing authorization, never ask for login on a filesystem error.
Reproduce failures with isolated input, preserve user config and run focused tests.
Never print credentials. Consult official hook docs only when changing its protocol.
