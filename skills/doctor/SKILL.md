---
name: doctor
description: "Diagnose the active agent client's harness installation, skill discovery and loading, hooks, MCP and index health. Load for harness health problems or audits; general task analysis, application code audits and solution design use their own workflow and stack skills."
---

# doctor

Identify the active client, its config and skill directories, supported installer
selector and diagnostic commands before running checks. Run the matching harness
installer check and the client's supported version and MCP diagnostics; do not
substitute another client's commands. An unsupported client capability is a
reported limitation, not a reason to switch clients.
For a skills audit, compare ~/.config/harness/repo/skills/*/SKILL.md with the active
client's installed skill links and the session's available-skills catalog; inspect
workflow triggers, relative references and required helpers. Check for missing,
dangling and stale links. shared/ is reference material.
Use supported native diagnostics when needed; keep reports local and quote only
relevant redacted checks. They do not prove skill loading or hook execution.
Harness uses SessionStart/UserPromptSubmit for shared skill routing context and
SessionStart/Stop for background index sync and startup RAG warmup. Context
delivery does not prove the model read a skill. Search routing is guidance.
Inspect .ragsave/sync.log and ~/.ai-hooks/logs/errors.log on failures.
Check actual MCP requests and index freshness; installed files and autosync=ok
do not prove hooks executed. Distinguish sandbox, network and authentication
errors; reuse existing authorization, never ask for login on a filesystem error.
Reproduce failures with isolated input, preserve user config and run focused tests.
Never print credentials. Consult official hook docs only when changing its protocol.
